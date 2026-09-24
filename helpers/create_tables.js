import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import SupportTicket from '../models/SupportTicket.js';
import FAQ from '../models/FAQs.js';
import WebUsers from '../models/WebUsers.js';

async function ensureTransactionsCollection() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const collectionNames = collections.map(col => col.name);

  if (!collectionNames.includes('transactions')) {
    const dummy = new Transaction({
      user: new mongoose.Types.ObjectId(),
      amount: 0,
      method_crypto: false,
      method_bank_transfer: false,
      method_payment_gateway: false,
      transaction_id: 'init-transaction-id',
      plan_id: new mongoose.Types.ObjectId(),
    });

    try {
      await dummy.save();
      await Transaction.deleteOne({ transaction_id: 'init-transaction-id' });
      console.log('`transactions` collection initialized.');
    } catch (err) {
      console.warn('Could not create transactions collection:', err.message);
    }
  } else {
    console.log('`transactions` collection already exists.');
  }
}

async function ensureSubscriptionPlansCollection() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const collectionNames = collections.map(col => col.name);

  if (!collectionNames.includes('subscriptionplans')) {
    try {
      // Create dummy plan and delete it to trigger collection creation
      const dummy = new SubscriptionPlan({
        name: 'Dummy Plan',
        id: 'init-plan-id',
        hashrate: 0,
        duration: 0,
        maintenance_cost: 0,
        plan_cost: 0
      });

      await dummy.save();
      await SubscriptionPlan.deleteOne({ id: 'init-plan-id' });

      console.log('`subscriptionplans` collection initialized.');
    } catch (err) {
      console.warn('Could not create subscriptionplans collection:', err.message);
    }
  } else {
    console.log('`subscriptionplans` collection already exists.');
  }
}

async function ensureSupportTicketCollection() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const collectionNames = collections.map(col => col.name);

  if (!collectionNames.includes('supporttickets')) {
    try {
      // Create dummy plan and delete it to trigger collection creation
      const dummy = new SupportTicket({
        user: new mongoose.Types.ObjectId(),
        name: 'Dummy Plan',
        email: 'Dummy Email',
        message: 'Dummy Message',
      });

      await dummy.save();
      await SupportTicket.deleteOne({ id: 'init-plan-id' });

      console.log('`SupportTickets` collection initialized.');
    } catch (err) {
      console.warn('Could not create SupportTickets collection:', err.message);
    }
  } else {
    console.log('`SupportTickets` collection already exists.');
  }
}

async function ensureFAQCollection() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const collectionNames = collections.map(col => col.name);

  if (!collectionNames.includes('faqs')) {
    try {
      // Create dummy plan and delete it to trigger collection creation
      const dummy = new FAQ({
        user: new mongoose.Types.ObjectId(),
        name: 'Dummy FAQ',
        message: 'Dummy FAQ Message',
      });

      await dummy.save();
      await FAQ.deleteOne({ id: 'init-plan-id' });

      console.log('`FAQs` collection initialized.');
    } catch (err) {
      console.warn('Could not create FAQs collection:', err.message);
    }
  } else {
    console.log('`FAQs` collection already exists.');
  }
}

async function ensureWebUsersCollection() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const collectionNames = collections.map(col => col.name);

  if (!collectionNames.includes('webusers')) {
    try {
      // Create dummy plan and delete it to trigger collection creation
      const dummy = new WebUsers({
        firstname: 'Dummy',
        lastname: 'Dummy',
        username: 'Dummy',
        orgname: 'Dummy',
        location: 'Dummy',
        email: 'Dummy',
        phone: 'Dummy',
      });

      await dummy.save();
      await WebUsers.deleteOne({ id: 'init-plan-id' });

      console.log('`WebUsers` collection initialized.');
    } catch (err) {
      console.warn('Could not create WebUsers collection:', err.message);
    }
  } else {
    console.log('`WebUsers` collection already exists.');
  }
}

async function tables_check() {
    await ensureSubscriptionPlansCollection();
    await ensureTransactionsCollection();
    await ensureSupportTicketCollection();
    await ensureFAQCollection();
    await ensureWebUsersCollection();
}

export default tables_check