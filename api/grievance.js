// Mock database to hold tickets in memory for the prototype
let tickets = [];

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { issueType, description } = req.body;
        
        const newTicket = {
            id: `TKT-${Math.floor(Math.random() * 90000) + 10000}`,
            issueType,
            description,
            status: 'Submitted -> Bank Review',
            date: new Date().toISOString().split('T')[0]
        };
        
        tickets.push(newTicket);
        return res.status(200).json({ success: true, ticket: newTicket });
    } 
    
    if (req.method === 'GET') {
        return res.status(200).json({ success: true, tickets });
    }
    
    res.status(405).send('Method Not Allowed');
};
