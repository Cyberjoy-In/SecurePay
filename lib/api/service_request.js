const { getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { requireUser, verifyRequest } = require('./_auth');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try { verifyRequest(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }
    try {
        const db = await getDatabase();
        const { user } = await requireUser(req, db);
        const requestType = String(req.body?.requestType || '').trim().slice(0, 80);
        const details = String(req.body?.details || '').trim().slice(0, 2000);
        if (!requestType || !details) return res.status(400).json({ error: 'Request type and details are required.' });
        const referenceId = createId('SRQ');
        await db.collection('service_requests').insertOne({ _id: referenceId, user_id: user._id, request_type: requestType, details, status: 'PENDING', created_at: new Date(), updated_at: new Date() });
        return res.status(201).json({ success: true, message: `Your request for '${requestType}' has been received.`, referenceId, status: 'Pending Processing' });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to create service request.' });
    }
};
