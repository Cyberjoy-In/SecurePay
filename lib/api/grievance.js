const { getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { requireUser, verifyRequest } = require('./_auth');

module.exports = async (req, res) => {
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try { verifyRequest(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }
    try {
        const db = await getDatabase();
        const { user } = await requireUser(req, db);
        const collection = db.collection('grievances');
        if (req.method === 'POST') {
            const issueType = String(req.body?.issueType || '').trim().slice(0, 80);
            const description = String(req.body?.description || '').trim().slice(0, 2000);
            if (!issueType || description.length < 5) return res.status(400).json({ error: 'Issue type and a useful description are required.' });
            const now = new Date();
            const newTicket = { _id: createId('TKT'), user_id: user._id, issueType, description, status: 'SUBMITTED', created_at: now, updated_at: now };
            await collection.insertOne(newTicket);
            return res.status(201).json({ success: true, ticket: { id: newTicket._id, issueType, description, status: 'Submitted -> Bank Review', date: now.toISOString().split('T')[0] } });
        }
        const tickets = await collection.find({ user_id: user._id }, { projection: { user_id: 0 } }).sort({ created_at: -1 }).limit(100).toArray();
        return res.status(200).json({ success: true, tickets: tickets.map(ticket => ({ ...ticket, id: ticket._id, date: new Date(ticket.created_at).toISOString().split('T')[0] })) });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to process grievance request.' });
    }
};
