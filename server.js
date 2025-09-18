// server.js - Your SplitEase Backend Server

// Add this to the TOP of your server.js file (after the requires)
const fs = require('fs');
const path = require('path');

// Data file path
const DATA_FILE = path.join(__dirname, 'data.json');

// Load data on startup
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      expenses = data.expenses || [];
      paymentLinks = data.paymentLinks || [];
      users = data.users || [];
      console.log('📂 Loaded existing data');
    }
  } catch (error) {
    console.log('📂 Starting with empty data');
  }
}

// Save data function
function saveData() {
  const data = { expenses, paymentLinks, users };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Call loadData when server starts
loadData();


const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 3000;

// Middleware
app.use(cors()); // Allows your frontend to talk to this backend

// Serve the frontend HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.json()); // Allows server to understand JSON data

// In-memory storage (temporary - will reset when server restarts)
// Later you'll replace this with a real database
let expenses = [];
let paymentLinks = [];
let users = [];

// ============= ROUTES =============

// Root route - just to test if server is running
app.get('/', (req, res) => {
  res.json({ 
    message: 'SplitEase API is running!',
    endpoints: [
      'GET /api/expenses',
      'POST /api/expenses',
      'GET /api/payment-links/:id',
      'POST /api/payment-links/:id/pay'
    ]
  });
});

// ----------- EXPENSE ROUTES -----------

// Create a new expense
app.post('/api/expenses', (req, res) => {
  try {
    const { description, amount, participants } = req.body;
    
    // Basic validation
    if (!description || !amount || !participants || participants.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    // Create the expense
    const expense = {
      id: Date.now().toString(),
      description: description,
      amount: amount,
      participants: participants.map(p => ({
        ...p,
        paid: false,
        paymentLinkId: Math.random().toString(36).substr(2, 9)
      })),
      createdAt: new Date().toISOString(),
      createdBy: req.body.createdBy || 'Anonymous'
    };
    
    // Generate payment links for each participant
    expense.participants.forEach(participant => {
      const paymentLink = {
        id: participant.paymentLinkId,
        expenseId: expense.id,
        amount: participant.amount,
        description: expense.description,
        payerName: participant.name,
        payerEmail: participant.email,
        requester: expense.createdBy,
        createdAt: expense.createdAt,
        used: false,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // Expires in 7 days
      };
      paymentLinks.push(paymentLink);
    });
    
    expenses.push(expense);
    saveData();
    
    res.status(201).json({ 
      success: true, 
      expense: expense,
      message: 'Expense created successfully!'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create expense' 
    });
  }
});

// Get all expenses
app.get('/api/expenses', (req, res) => {
  res.json({
    success: true,
    count: expenses.length,
    expenses: expenses
  });
});

// Get a single expense by ID
app.get('/api/expenses/:id', (req, res) => {
  const expense = expenses.find(e => e.id === req.params.id);
  
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

// ----------- PAYMENT LINK ROUTES -----------

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
  
  // Check if link is expired
  if (new Date(paymentLink.expiresAt) < new Date()) {
    return res.status(410).json({ 
      success: false, 
      error: 'This payment link has expired' 
    });
  }
  
  res.json({
    success: true,
    paymentDetails: {
      amount: paymentLink.amount,
      description: paymentLink.description,
      requester: paymentLink.requester,
      payerName: paymentLink.payerName
    }
  });
});

// Process a payment (simulation - in reality, this would integrate with Stripe/PayPal)
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
  saveData();


  paymentLink.paidAt = new Date().toISOString();
  paymentLink.paymentMethod = paymentMethod;
  
  // Update the expense to mark participant as paid
  const expense = expenses.find(e => e.id === paymentLink.expenseId);
  if (expense) {
    const participant = expense.participants.find(p => p.paymentLinkId === paymentLink.id);
    if (participant) {
      participant.paid = true;
      participant.paidAt = paymentLink.paidAt;
      participant.paymentMethod = paymentMethod;
    }
  }
  
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

// ----------- USER ROUTES (Basic) -----------

// Create a user (signup simulation)
app.post('/api/users/signup', (req, res) => {
  const { name, email } = req.body;
  
  // Check if user already exists
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ 
      success: false, 
      error: 'User already exists' 
    });
  }
  
  const user = {
    id: Date.now().toString(),
    name: name,
    email: email,
    createdAt: new Date().toISOString()
  };
  
  users.push(user);
  saveData();
  
  res.status(201).json({
    success: true,
    user: user,
    message: 'Account created successfully!'
  });
});

// ----------- STATS ROUTE -----------

// Get statistics
app.get('/api/stats', (req, res) => {
  const totalExpenses = expenses.length;
  const totalAmount = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const totalPaid = paymentLinks.filter(p => p.used).length;
  const totalPending = paymentLinks.filter(p => !p.used).length;
  
  res.json({
    success: true,
    stats: {
      totalExpenses,
      totalAmount,
      totalPaid,
      totalPending,
      totalUsers: users.length
    }
  });
});

// ----------- ERROR HANDLING -----------

// Handle 404 for undefined routes
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Route not found' 
  });
});

// ----------- START SERVER -----------

app.listen(PORT, () => {
  console.log('🚀 SplitEase server is running!');
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Test the API: http://localhost:${PORT}/`);
  console.log('\n Available endpoints:');
  console.log('   GET  http://localhost:3000/');
  console.log('   GET  http://localhost:3000/api/expenses');
  console.log('   POST http://localhost:3000/api/expenses');
  console.log('   GET  http://localhost:3000/api/payment-links/:id');
  console.log('   POST http://localhost:3000/api/payment-links/:id/pay');
  console.log('   GET  http://localhost:3000/api/stats');
  console.log('\nPress Ctrl+C to stop the server');
});