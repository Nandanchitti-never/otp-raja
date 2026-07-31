const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// ── SUPABASE CLIENT ──────────────────────────────────────────────
// IMPORTANT: Get your service_role key from Supabase Dashboard > Settings > API
// DO NOT expose this key to the frontend!
const supabase = createClient(
  'https://haebfqovlhllqgpotwgw.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhZWJmcW92bGhsbHFncG90d2d3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTgxNTA3MywiZXhwIjoyMDk3MzkxMDczfQ.Mu_iFPNQWx54qmim_UjUJWUZiWc6Vo9WNQ8FyMVtUGo'
);

// ── MIDDLEWARE ──────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));
app.use(express.json());

// ── RAZORPAY ────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

console.log('✅ Razorpay initialized with key:', process.env.RAZORPAY_KEY_ID);

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Server is running!',
    razorpay_key: process.env.RAZORPAY_KEY_ID
  });
});

// ── CREATE ORDER ────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    console.log('📦 Creating order...');
    
    const { amount, currency, receipt, user_id } = req.body;
    
    const options = {
      amount: amount || 40000,
      currency: currency || 'INR',
      receipt: receipt || `receipt_${Date.now()}`,
      payment_capture: 1
    };
    
    const order = await razorpay.orders.create(options);
    
    console.log('✅ Order created:', order.id);
    
    // Save pending subscription in Supabase
    const { error } = await supabase
      .from('subscriptions')
      .insert({
        user_id: user_id,
        status: 'pending',
        amount: options.amount,
        currency: options.currency,
        razorpay_order_id: order.id
      });
    
    if (error) console.warn('⚠️ Failed to save pending subscription:', error);
    
    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    });
    
  } catch (error) {
    console.error('❌ Order creation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ── VERIFY PAYMENT ──────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    console.log('🔐 Verifying payment...');
    
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      amount,
      expiry,
      user_id
    } = req.body;
    
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');
    
    const isValid = expectedSignature === razorpay_signature;
    
    console.log(`🔐 Signature verification: ${isValid ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log('📝 Payment ID:', razorpay_payment_id);
    console.log('📝 Order ID:', razorpay_order_id);
    
    if (!isValid) {
      return res.status(400).json({
        verified: false,
        error: 'Invalid signature'
      });
    }
    
    // Update subscription in Supabase
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        verified: true,
        razorpay_payment_id: razorpay_payment_id,
        razorpay_signature: razorpay_signature,
        expiry_date: expiry || '2027-06-30'
      })
      .eq('razorpay_order_id', razorpay_order_id)
      .select();
    
    if (subError) {
      console.warn('⚠️ Failed to update subscription:', subError);
    } else {
      console.log('✅ Subscription updated in database');
    }
    
    res.json({
      verified: true,
      payment_id: razorpay_payment_id,
      order_id: razorpay_order_id,
      amount: amount,
      expiry: expiry,
      message: 'Payment verified successfully'
    });
    
  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(500).json({
      verified: false,
      error: error.message
    });
  }
});

// ── CHECK SUBSCRIPTION STATUS ──────────────────────────────────
app.get('/subscription-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('verified', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('❌ Subscription check error:', error);
      return res.status(500).json({
        hasSubscription: false,
        error: error.message
      });
    }
    
    const subscription = data && data.length > 0 ? data[0] : null;
    
    if (!subscription) {
      return res.json({
        hasSubscription: false,
        isActive: false
      });
    }
    
    // Check if subscription is still valid (not expired)
    const expiryDate = subscription.expiry_date ? new Date(subscription.expiry_date) : null;
    const isActive = expiryDate ? expiryDate >= new Date() : true;
    
    res.json({
      hasSubscription: true,
      isActive: isActive,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        verified: subscription.verified,
        expiry_date: subscription.expiry_date,
        amount: subscription.amount
      }
    });
    
  } catch (error) {
    console.error('❌ Subscription check error:', error);
    res.status(500).json({
      hasSubscription: false,
      error: error.message
    });
  }
});

// ── START SERVER ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
});