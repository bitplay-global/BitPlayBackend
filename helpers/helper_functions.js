import mongoose from 'mongoose';
import SupportTicket from '../models/SupportTicket.js';

async function total_users() {
    var usersCount = 0;

    const collections = await mongoose.connection.db.listCollections().toArray();
    const tableNames = collections.map(col => col.name);

    if (tableNames.includes('users')) {
        const usersCollection = mongoose.connection.db.collection('users');
        usersCount = await usersCollection.countDocuments();
    } else {
        usersCount = 0
        console.warn('No "users" collection found.');
    }

    return usersCount;
}

async function total_users_filtered(start, end) {
    var usersCount = 0;

    const collections = await mongoose.connection.db.listCollections().toArray();
    const tableNames = collections.map(col => col.name);

    if (tableNames.includes('users')) {
        const usersCollection = mongoose.connection.db.collection('users');
        usersCount = await usersCollection.countDocuments({
            createdAt: { $gte: start, $lte: end }
        });
    } else {
        usersCount = 0;
    }

    return usersCount;
}

async function table_names() {
    const collections = await mongoose.connection.db.listCollections().toArray();
    const tableNames = collections.map(col => col.name);

    console.log("Tables: ", tableNames)
    return tableNames;
}

async function total_transactions() {
    const TransactionsCollection = mongoose.connection.db.collection('transactions');
    const TransactionsCount = await TransactionsCollection.countDocuments();

    return TransactionsCount;
}

async function TotalSupportTickets() {
    const SupportTicketsCount = await SupportTicket.countDocuments();
    return SupportTicketsCount;
}

async function TotalSupportTicketsFiltered(start, end) {
    const SupportTicketsCount = await SupportTicket.countDocuments({
        createdAt: { $gte: start, $lte: end }
    });
    return SupportTicketsCount;
}

async function TotalFAQs() {
    const FAQsCountCollection = mongoose.connection.db.collection('faqs');
    const FAQsCount = await FAQsCountCollection.countDocuments();

    return FAQsCount;
}

export default {
    total_users,
    total_users_filtered,
    table_names,
    total_transactions,
    TotalSupportTickets,
    TotalSupportTicketsFiltered,
    TotalFAQs
}