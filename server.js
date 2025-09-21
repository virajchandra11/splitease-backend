// server.js - Your SplitEase Backend Server with Authentication

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// NEW: Authentication imports
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

const app = express();
const PORT = process.env.PORT || 3000;

// NEW: Authentication configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE;

// Initialize services
let twilioClient;
if (TWILIO_SID && TWILIO_TOKEN) {
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
}

// Make email transporter optional for development
let emailTransporter;
try {
    emailTransporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
} catch (error) {
    console.log('📧 Email transporter not configured - using development mode');
    emailTransporter = null;
}

// Data file path
const DATA_FILE = path.join(__dirname, 'data.json');

// In-memory storage
let expenses = [];
let paymentLinks = [];
let users = [];
let verificationCodes = []; // NEW: For phone/email verification

// Load data on startup
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      expenses = data.expenses || [];
      paymentLinks = data.paymentLinks || [];
      users = data.users || [];
      verificationCodes = data.verificationCodes || []; // NEW
      console.log('📂 Loaded existing data');
    }
  } catch (error) {
    console.log('📂 Starting with empty data');
  }
}

// Save data function
function saveData() {
  const data = { expenses, paymentLinks, users, verificationCodes }; // NEW: Include verification codes
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// NEW: Utility functions for authentication
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function detectContactType(contact) {
    if (contact.includes('@')) {
        return isValidEmail(contact) ? 'email' : null;
    } else {
        try {
            const phoneNumber = parsePhoneNumber(contact, 'US');
            return phoneNumber.isValid() ? 'phone' : null;
        } catch {
            return null;
        }
    }
}

// NEW: Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// Call loadData when server starts
loadData();

// Middleware
app.use(cors());
app.use(express.json());

// Serve the frontend HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============= NEW: AUTHENTICATION ROUTES =============

// POST /api/auth/request-code - Request verification code
app.post('/api/auth/request-code', async (req, res) => {
    try {
        const { contact, name, isSignup } = req.body;
        
        if (!contact) {
            return res.status(400).json({ error: 'Phone number or email is required' });
        }

        const contactType = detectContactType(contact);
        if (!contactType) {
            return res.status(400).json({ error: 'Invalid phone number or email format' });
        }

        // For signup, require name
        if (isSignup && !name) {
            return res.status(400).json({ error: 'Name is required for signup' });
        }

        // Normalize contact
        const normalizedContact = contactType === 'phone' 
            ? parsePhoneNumber(contact, 'US').format('E.164')
            : contact.toLowerCase();

        // Check if user exists
        const existingUser = users.find(u => 
            u.phone === normalizedContact || u.email === normalizedContact
        );

        if (isSignup && existingUser) {
            return res.status(400).json({ error: 'Account already exists. Try logging in instead.' });
        }

        if (!isSignup && !existingUser) {
            return res.status(404).json({ error: 'Account not found. Please sign up first.' });
        }

        // Generate verification code
        const code = generateVerificationCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Remove old codes for this contact
        verificationCodes = verificationCodes.filter(vc => vc.contact !== normalizedContact);

        // Store new code
        verificationCodes.push({
            contact: normalizedContact,
            code,
            expiresAt,
            used: false,
            name: isSignup ? name : (existingUser ? existingUser.name : null),
            isSignup
        });

        saveData();

        // Send verification code
        if (contactType === 'phone') {
            if (!twilioClient) {
                // Development mode - log code to console
                console.log(`🔐 SMS CODE for ${normalizedContact}: ${code}`);
                return res.json({ 
                    success: true, 
                    message: 'Verification code sent via SMS',
                    contactType: 'phone',
                    devMode: true,
                    code: process.env.NODE_ENV === 'development' ? code : undefined
                });
            }

            await twilioClient.messages.create({
                body: `Your SplitEase verification code is: ${code}`,
                from: TWILIO_PHONE,
                to: normalizedContact
            });
        } else {
            if (!process.env.EMAIL_USER) {
                // Development mode - log code to console
                console.log(`🔐 EMAIL CODE for ${normalizedContact}: ${code}`);
                return res.json({ 
                    success: true, 
                    message: 'Verification code sent via email',
                    contactType: 'email',
                    devMode: true,
                    code: process.env.NODE_ENV === 'development' ? code : undefined
                });
            }

            await emailTransporter.sendMail({
                from: process.env.EMAIL_USER,
                to: normalizedContact,
                subject: 'Your SplitEase Verification Code',
                text: `Your verification code is: ${code}`,
                html: `<p>Your SplitEase verification code is: <strong>${code}</strong></p>`
            });
        }

        res.json({ 
            success: true, 
            message: `Verification code sent via ${contactType}`,
            contactType
        });

    } catch (error) {
        console.error('Error sending verification code:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

// POST /api/auth/verify-code - Verify code and login/signup
app.post('/api/auth/verify-code', (req, res) => {
    try {
        const { contact, code } = req.body;

        if (!contact || !code) {
            return res.status(400).json({ error: 'Contact and code are required' });
        }

        const contactType = detectContactType(contact);
        const normalizedContact = contactType === 'phone' 
            ? parsePhoneNumber(contact, 'US').format('E.164')
            : contact.toLowerCase();

        // Find verification code
        const verificationIndex = verificationCodes.findIndex(vc => 
            vc.contact === normalizedContact && 
            vc.code === code && 
            !vc.used && 
            new Date() < vc.expiresAt
        );

        if (verificationIndex === -1) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        const verification = verificationCodes[verificationIndex];
        
        // Mark code as used
        verificationCodes[verificationIndex].used = true;

        let user;

        if (verification.isSignup) {
            // Create new user
            user = {
                id: Date.now().toString(),
                name: verification.name,
                [contactType]: normalizedContact,
                verified: true,
                createdAt: new Date()
            };
            users.push(user);
        } else {
            // Find existing user
            user = users.find(u => u.phone === normalizedContact || u.email === normalizedContact);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
        }

        saveData();

        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, name: user.name },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            message: verification.isSignup ? 'Account created successfully' : 'Logged in successfully',
            token,
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone || null,
                email: user.email || null
            }
        });

    } catch (error) {
        console.error('Error verifying code:', error);
        res.status(500).json({ error: 'Failed to verify code' });
    }
});

// GET /api/auth/me - Get current user info
app.get('/api/auth/me', authenticateToken, (req, res) => {
    const user = users.find(u => u.id === req.user.userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    res.json({
        id: user.id,
        name: user.name,
        phone: user.phone || null,
        email: user.email || null
    });
});

// ============= UPDATED: EXPENSE ROUTES (Now with Authentication) =============

// Create a new expense (NOW REQUIRES AUTHENTICATION)
app.post('/api/expenses', authenticateToken, (req, res) => {
  try {
    const { description, amount, participants, splitType } = req.body;
    const userId = req.user.userId;
    const userName = req.user.name;
    
    // Get full user info
    const user = users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Basic validation
    if (!description || !amount || !participants || participants.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    // Calculate amounts - including the payer in the split
    const totalPeople = participants.length + 1; // +1 for the person who paid
    const amountPerPerson = amount / totalPeople;
    
    // Create the expense
    const expense = {
      id: Date.now().toString(),
      description: description,
      amount: parseFloat(amount),
      participants: participants.map(participant => {
        const paymentLinkId = Math.random().toString(36).substr(2, 15);
        
        // Create payment link
        const paymentLink = {
          id: paymentLinkId,
          expenseId: Date.now().toString(),
          participantName: participant.name,
          participantEmail: participant.email,
          amount: amountPerPerson,
          description: description,
          paidBy: {
            name: userName,
            phone: user.phone,
            email: user.email
          },
          used: false,
          createdAt: new Date()
        };
        
        paymentLinks.push(paymentLink);
        
        return {
          name: participant.name,
          email: participant.email,
          amount: amountPerPerson,
          paymentLink: paymentLinkId,
          paid: false
        };
      }),
      paidBy: {
        id: userId,
        name: userName,
        phone: user.phone,
        email: user.email
      },
      splitType: splitType || 'equal',
      createdAt: new Date(),
      totalPeople: totalPeople
    };
    
    expenses.push(expense);
    saveData();
    
    res.status(201).json({ 
      success: true, 
      expense: expense,
      message: 'Expense created successfully!'
    });
    
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create expense' 
    });
  }
});

// Get expenses (NOW SHOWS ONLY USER'S EXPENSES)
app.get('/api/expenses', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const userExpenses = expenses.filter(expense => expense.paidBy.id === userId);
  
  res.json({
    success: true,
    count: userExpenses.length,
    expenses: userExpenses
  });
});

// Get a single expense by ID (PROTECTED)
app.get('/api/expenses/:id', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const expense = expenses.find(e => e.id === req.params.id && e.paidBy.id === userId);
  
  if (!expense) {
    return res.status(404).json({ 
      success: false, 
      error: 'Expense not found' 
    });
  }
  
  res.json({
    success: true,
    expense: expense
  });
});

// ============= EXISTING: PAYMENT LINK ROUTES (Unchanged) =============

// Get payment link details (what non-app users see)
app.get('/api/payment-links/:id', (req, res) => {
  const paymentLink = paymentLinks.find(p => p.id === req.params.id);
  
  if (!paymentLink) {
    return res.status(404).json({ 
      success: false, 
      error: 'Payment link not found or expired' 
    });
  }
  
  if (paymentLink.used) {
    return res.status(410).json({ 
      success: false, 
      error: 'This payment link has already been used' 
    });
  }
  
  res.json({
    success: true,
    paymentDetails: {
      amount: paymentLink.amount,
      description: paymentLink.description,
      paidBy: paymentLink.paidBy,
      participantName: paymentLink.participantName
    }
  });
});

// Process a payment
app.post('/api/payment-links/:id/pay', (req, res) => {
  const { paymentMethod } = req.body;
  const paymentLink = paymentLinks.find(p => p.id === req.params.id);
  
  if (!paymentLink) {
    return res.status(404).json({ 
      success: false, 
      error: 'Payment link not found' 
    });
  }
  
  if (paymentLink.used) {
    return res.status(400).json({ 
      success: false, 
      error: 'Payment already processed' 
    });
  }
  
  // Mark payment link as used
  paymentLink.used = true;
  paymentLink.paidAt = new Date().toISOString();
  paymentLink.paymentMethod = paymentMethod;
  
  // Update the expense to mark participant as paid
  const expense = expenses.find(e => e.id === paymentLink.expenseId);
  if (expense) {
    const participant = expense.participants.find(p => p.paymentLink === paymentLink.id);
    if (participant) {
      participant.paid = true;
      participant.paidAt = paymentLink.paidAt;
      participant.paymentMethod = paymentMethod;
    }
  }
  
  saveData();
  
  res.json({
    success: true,
    message: 'Payment processed successfully!',
    payment: {
      amount: paymentLink.amount,
      method: paymentMethod,
      paidAt: paymentLink.paidAt
    }
  });
});

// ============= UPDATED: STATS ROUTE (Now with Authentication) =============

// Get statistics (PROTECTED)
app.get('/api/stats', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const userExpenses = expenses.filter(e => e.paidBy.id === userId);
  const userPaymentLinks = paymentLinks.filter(p => 
    userExpenses.some(e => e.id === p.expenseId)
  );
  
  const totalExpenses = userExpenses.length;
  const totalAmount = userExpenses.reduce((sum, exp) => sum + exp.amount, 0);
  const totalPaid = userPaymentLinks.filter(p => p.used).length;
  const totalPending = userPaymentLinks.filter(p => !p.used).length;
  
  res.json({
    success: true,
    stats: {
      totalExpenses,
      totalAmount,
      totalPaid,
      totalPending
    }
  });
});

// TEST: Simple auth test page
app.get('/test-auth', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Test SplitEase Auth</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
                input { padding: 10px; margin: 5px 0; border: 1px solid #ddd; border-radius: 5px; }
                button { padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; }
                #result { margin-top: 20px; padding: 15px; background: #f9f9f9; border-radius: 5px; white-space: pre-wrap; }
            </style>
        </head>
        <body>
            <h2>🧪 Test SplitEase Authentication</h2>
            
            <h3>Step 1: Request Verification Code</h3>
            <form id="requestForm">
                <input type="text" id="contact" placeholder="Phone: +1234567890 or Email: test@email.com" style="width: 100%"><br>
                <input type="text" id="name" placeholder="Your Name" style="width: 100%"><br>
                <label><input type="checkbox" id="isSignup" checked> Sign Up (uncheck to test Login)</label><br><br>
                <button type="submit">📱 Send Verification Code</button>
            </form>
            
            <h3>Step 2: Verify Code</h3>
            <form id="verifyForm">
                <input type="text" id="verifyContact" placeholder="Same phone/email as above" style="width: 100%"><br>
                <input type="text" id="code" placeholder="6-digit code (check server console)" style="width: 100%"><br><br>
                <button type="submit">✅ Verify & Login</button>
            </form>
            
            <div id="result"></div>
            
            <script>
                document.getElementById('requestForm').onsubmit = async (e) => {
                    e.preventDefault();
                    const contact = document.getElementById('contact').value;
                    const name = document.getElementById('name').value;
                    const isSignup = document.getElementById('isSignup').checked;
                    
                    document.getElementById('result').innerHTML = '⏳ Sending request...';
                    
                    try {
                        const response = await fetch('/api/auth/request-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ contact, name, isSignup })
                        });
                        const data = await response.json();
                        
                        if (data.success) {
                            document.getElementById('result').innerHTML = 
                                '✅ SUCCESS!\\n\\n' + JSON.stringify(data, null, 2) + 
                                '\\n\\n🔍 Check your server console for the verification code!';
                        } else {
                            document.getElementById('result').innerHTML = 
                                '❌ ERROR:\\n\\n' + JSON.stringify(data, null, 2);
                        }
                    } catch (error) {
                        document.getElementById('result').innerHTML = '❌ Network Error: ' + error.message;
                    }
                };
                
                document.getElementById('verifyForm').onsubmit = async (e) => {
                    e.preventDefault();
                    const contact = document.getElementById('verifyContact').value;
                    const code = document.getElementById('code').value;
                    
                    document.getElementById('result').innerHTML = '⏳ Verifying...';
                    
                    try {
                        const response = await fetch('/api/auth/verify-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ contact, code })
                        });
                        const data = await response.json();
                        
                        if (data.success) {
                            document.getElementById('result').innerHTML = 
                                '🎉 AUTHENTICATION SUCCESS!\\n\\n' + JSON.stringify(data, null, 2) +
                                '\\n\\n💾 Save this token to make authenticated requests!';
                        } else {
                            document.getElementById('result').innerHTML = 
                                '❌ VERIFICATION FAILED:\\n\\n' + JSON.stringify(data, null, 2);
                        }
                    } catch (error) {
                        document.getElementById('result').innerHTML = '❌ Network Error: ' + error.message;
                    }
                };
            </script>
        </body>
        </html>
    `);
});

// ============= ERROR HANDLING =============

// Handle 404 for undefined routes
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Route not found' 
  });
});

// ============= START SERVER =============

app.listen(PORT, () => {
  console.log('🚀 SplitEase server is running!');
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Test the API: http://localhost:${PORT}/`);
  console.log('\n🔐 NEW: Authentication endpoints:');
  console.log('   POST http://localhost:' + PORT + '/api/auth/request-code');
  console.log('   POST http://localhost:' + PORT + '/api/auth/verify-code');
  console.log('   GET  http://localhost:' + PORT + '/api/auth/me');
  console.log('\n💰 Existing endpoints (now protected):');
  console.log('   GET  http://localhost:' + PORT + '/api/expenses');
  console.log('   POST http://localhost:' + PORT + '/api/expenses');
  console.log('   GET  http://localhost:' + PORT + '/api/stats');
  console.log('\n🔗 Public payment links (no auth required):');
  console.log('   GET  http://localhost:' + PORT + '/api/payment-links/:id');
  console.log('   POST http://localhost:' + PORT + '/api/payment-links/:id/pay');
  console.log('\nPress Ctrl+C to stop the server');
});