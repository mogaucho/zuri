/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import TradingArena from './components/TradingArena';
import LandingPage from './components/LandingPage';

export default function App() {
  const [showArena, setShowArena] = useState(false);

  return (
    <div className="min-h-screen bg-slate-950">
      {showArena ? (
        <TradingArena onBack={() => setShowArena(false)} />
      ) : (
        <LandingPage onStart={() => setShowArena(true)} />
      )}
    </div>
  );
}
