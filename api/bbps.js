module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { type, accountNumber, amount } = req.body;

        // Auto-detect provider if it's a mobile recharge
        let provider = "Unknown Provider";
        if (type === 'mobile') {
            const prefix = accountNumber.substring(0, 4);
            if (['9876', '9898', '9999'].includes(prefix)) provider = "Airtel";
            else if (['9444', '9400'].includes(prefix)) provider = "BSNL";
            else if (['8989', '7000'].includes(prefix)) provider = "Jio";
            else provider = "Vi (Vodafone Idea)";
        }

        // In a real database, you would deduct 'amount' from the user's balance here.
        return res.status(200).json({ 
            success: true, 
            message: `Successfully paid ₹${amount} for ${type} to ${provider} (${accountNumber}).`,
            providerDetected: provider,
            transactionId: `TXN${Math.floor(Math.random() * 1000000)}`
        });
    }
    res.status(405).send('Method Not Allowed');
};
