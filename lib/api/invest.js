const { getRequiredEnv } = require('./_config');

module.exports = async (req, res) => {
    if (req.method === 'GET') {
        const symbol = req.query.symbol || 'AAPL';
        
        try {
            // Fetch live quote from Finnhub
            const apiKey = getRequiredEnv('FINNHUB_API_KEY');
            const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`);
            const data = await response.json();
            
            // Format the portfolio data
            return res.status(200).json({
                success: true,
                symbol: symbol,
                currentPrice: data.c, // Current price
                high: data.h,         // High price of the day
                low: data.l,          // Low price of the day
                open: data.o          // Open price of the day
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to fetch market data." });
        }
    }
    res.status(405).send('Method Not Allowed');
};
