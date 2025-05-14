import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './index.css';

function App() {
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    const fetchTransactions = async () => {
      try {
        const response = await axios.get('/api/transactions');
        setTransactions(response.data);
      } catch (error) {
        console.error('Error fetching transactions:', error);
      }
    };

    fetchTransactions();
    const interval = setInterval(fetchTransactions, 10000); // Poll every 10 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app-container">
      <h1 className="app-title">PETS Buy Tracker</h1>
      <div className="transaction-list">
        {transactions.length === 0 ? (
          <p className="no-transactions">No transactions yet.</p>
        ) : (
          <ul className="transaction-items">
            {transactions.map((tx, index) => (
              <li key={index} className="transaction-item">
                <h3 className="transaction-category">{tx.category}</h3>
                <p>Chain: {tx.chain}</p>
                <p>To: {tx.to}</p>
                <p>Amount: {tx.amount} PETS</p>
                <p>{tx.isPairTrade ? 'BSC-ETH Pair Trade' : 'Standard Transfer'}</p>
                <video
                  src={tx.video}
                  controls
                  className="transaction-video"
                  autoPlay
                  muted
                  loop
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default App;