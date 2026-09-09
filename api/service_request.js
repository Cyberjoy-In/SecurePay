module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { requestType, details } = req.body;
        
        // Mock saving the request to a database
        const referenceId = `SRQ-${Date.now()}`;
        
        return res.status(200).json({
            success: true,
            message: `Your request for '${requestType}' has been received.`,
            referenceId: referenceId,
            status: "Pending Processing"
        });
    }
    res.status(405).send('Method Not Allowed');
};
