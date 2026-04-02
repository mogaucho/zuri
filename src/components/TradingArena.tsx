import React, { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { 
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine 
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Trophy, User, ArrowUpCircle, ArrowDownCircle, RefreshCcw, Globe } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { auth, db } from "../firebase";
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { doc, onSnapshot, collection, query, where, orderBy, limit } from "firebase/firestore";

// ... inside TradingArena component, after the first useEffect ...
interface PriceData {
  time: string;
  price: number;
}

interface LeaderboardEntry {
  userId: string;
  balance: number;
}

interface Trade {
  id?: string;
  userId: string;
  direction: "buy" | "sell";
  amount: number;
  entry: number;
  exitPrice?: number;
  status: "open" | "closed";
  closeReason?: string;
  stopLoss?: number;
  takeProfit?: number;
  pattern?: string;
  orderType?: "market" | "limit" | "stop";
  targetPrice?: number;
  createdAt?: any;
}

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  isUp: boolean;
}

interface TradingArenaProps {
  onBack?: () => void;
}

export default function TradingArena({ onBack }: TradingArenaProps) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [balance, setBalance] = useState<number>(10000);
  const [priceHistory, setPriceHistory] = useState<PriceData[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(100);
  const [roundId, setRoundId] = useState<number>(1);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeHistory, setTradeHistory] = useState<Trade[]>([]);
  const [globalTrades, setGlobalTrades] = useState<Trade[]>([]);
  const [tradeAmount, setTradeAmount] = useState<number>(500);
  const [stopLoss, setStopLoss] = useState<number>(5);
  const [takeProfit, setTakeProfit] = useState<number>(10);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentCandle, setCurrentCandle] = useState<Partial<Candle> | null>(null);
  const [orderType, setOrderType] = useState<"market" | "limit" | "stop">("market");
  const [targetPrice, setTargetPrice] = useState<number>(100);
  const [selectedPattern, setSelectedPattern] = useState<string>("None");
  const [isScanning, setIsScanning] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [showPatternLibrary, setShowPatternLibrary] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState(1000);
  const [isDepositing, setIsDepositing] = useState(false);
  const [isAiBotEnabled, setIsAiBotEnabled] = useState(false);
  const aiBotIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const PATTERN_DESCRIPTIONS: Record<string, string> = {
    "Double Top": "A bearish reversal pattern consisting of two peaks at nearly the same price level.",
    "Double Bottom": "A bullish reversal pattern consisting of two troughs at nearly the same price level.",
    "Head & Shoulders": "A bearish reversal pattern with three peaks, the middle being the highest.",
    "Inverse H&S": "A bullish reversal pattern with three troughs, the middle being the lowest.",
    "Bullish Engulfing": "A two-candle bullish reversal pattern where the second candle completely engulfs the first.",
    "Bearish Engulfing": "A two-candle bearish reversal pattern where the second candle completely engulfs the first.",
    "Hammer": "A bullish reversal candle with a small body and a long lower wick.",
    "Shooting Star": "A bearish reversal candle with a small body and a long upper wick.",
    "Ascending Triangle": "A bullish continuation pattern with a flat top and rising bottom.",
    "Descending Triangle": "A bearish continuation pattern with a flat bottom and falling top.",
    "Bull Flag": "A bullish continuation pattern following a sharp price increase.",
    "Bear Flag": "A bearish continuation pattern following a sharp price decrease.",
    "Support Breakout": "Price breaking below a significant support level.",
    "Resistance Breakout": "Price breaking above a significant resistance level."
  };

  const TRADE_PATTERNS = [
    "None",
    "Double Top",
    "Double Bottom",
    "Head & Shoulders",
    "Inverse H&S",
    "Bullish Engulfing",
    "Bearish Engulfing",
    "Hammer",
    "Shooting Star",
    "Ascending Triangle",
    "Descending Triangle",
    "Bull Flag",
    "Bear Flag",
    "Support Breakout",
    "Resistance Breakout"
  ];

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        const s = io(window.location.origin);
        setSocket(s);
        s.emit("register", u.uid);

        s.on("priceUpdate", (data: { price: number; roundId: number }) => {
          setCurrentPrice(data.price);
          setRoundId(data.roundId);
          
          setPriceHistory((prev) => {
            const newHistory = [...prev, { time: new Date().toLocaleTimeString(), price: data.price }];
            return newHistory.slice(-30);
          });

          // Candlestick Logic (5-second candles)
          setCurrentCandle((prev) => {
            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            if (!prev || (now.getSeconds() % 5 === 0 && prev.time !== timeStr)) {
              // Start new candle
              if (prev && prev.open !== undefined) {
                setCandles((old) => {
                  const newCandles = [...old, {
                    time: prev.time!,
                    open: prev.open!,
                    high: prev.high!,
                    low: prev.low!,
                    close: data.price,
                    isUp: data.price >= prev.open!
                  }];
                  return newCandles.slice(-20);
                });
              }
              return {
                time: timeStr,
                open: data.price,
                high: data.price,
                low: data.price,
                close: data.price,
              };
            } else {
              // Update current candle
              return {
                ...prev,
                high: Math.max(prev.high || data.price, data.price),
                low: Math.min(prev.low || data.price, data.price),
                close: data.price,
              };
            }
          });
        });

        s.on("balanceUpdate", (b: number) => setBalance(b));
        
        s.on("depositStatus", (data: { status: string; message: string; amount: number }) => {
          if (data.status === "success") {
            setAiSuggestion(data.message);
            setTimeout(() => setAiSuggestion(null), 5000);
          }
        });
        
        s.on("tradeClosed", (data: { profit: number; balance: number; reason?: string }) => {
          setBalance(data.balance);
          alert(`${data.reason || 'Trade Closed'}! Profit: KES ${data.profit.toFixed(2)}`);
        });

        s.on("userTradesUpdate", (data: { activeTrades: Trade[], tradeHistory: Trade[] }) => {
          setTrades(data.activeTrades);
          setTradeHistory(data.tradeHistory);
        });

        s.on("globalTradesUpdate", (data: Trade[]) => {
          setGlobalTrades(data);
        });

        s.on("leaderboardUpdate", (data: LeaderboardEntry[]) => setLeaderboard(data));
        
        s.on("errorMsg", (msg: string) => setError(msg));

        return () => {
          s.disconnect();
        };
      }
    });

    return () => unsubscribe();
  }, []);

  const scanPatterns = async () => {
    if (candles.length < 5) {
      setError("Need at least 5 candles for AI analysis");
      return;
    }
    setIsScanning(true);
    setAiSuggestion(null);
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const candleData = candles.map(c => `O:${c.open}, H:${c.high}, L:${c.low}, C:${c.close}`).join("\n");
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze these 5-second candlesticks and identify the most likely technical pattern (e.g., Bullish Engulfing, Hammer, Double Top, etc.). Return ONLY the name of the pattern. If none, return "None".\n\n${candleData}`,
      });

      const pattern = response.text?.trim() || "None";
      setAiSuggestion(pattern);
      if (TRADE_PATTERNS.includes(pattern)) {
        setSelectedPattern(pattern);
      }
    } catch (e) {
      console.error("AI Scan Error:", e);
      setError("AI Scanner failed");
    } finally {
      setIsScanning(false);
    }
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error("Login Error:", e);
    }
  };

  const openTrade = (direction: "buy" | "sell", customParams?: Partial<Trade>) => {
    if (!user || !socket) return;
    const amount = customParams?.amount || tradeAmount;
    if (amount > balance) {
      setError("Insufficient balance");
      return;
    }
    socket.emit("openTrade", { 
      userId: user.uid, 
      direction, 
      amount: amount,
      stopLoss: customParams?.stopLoss ?? stopLoss,
      takeProfit: customParams?.takeProfit ?? takeProfit,
      orderType: customParams?.orderType ?? orderType,
      targetPrice: customParams?.targetPrice ?? targetPrice,
      pattern: customParams?.pattern ?? selectedPattern
    });
    setError(null);
  };

  // AI Bot Logic
  useEffect(() => {
    if (isAiBotEnabled && user) {
      aiBotIntervalRef.current = setInterval(async () => {
        if (trades.length >= 5) return; // Don't over-trade

        // 1. Scan for pattern
        await scanPatterns();
        
        // 2. Decide trade parameters
        const directions: ("buy" | "sell")[] = ["buy", "sell"];
        const orderTypes: ("market" | "limit" | "stop")[] = ["market", "limit", "stop"];
        
        const direction = directions[Math.floor(Math.random() * directions.length)];
        const type = orderTypes[Math.floor(Math.random() * orderTypes.length)];
        
        // Randomize target price for limit/stop orders based on current price
        let target = currentPrice;
        if (type === "limit") {
          target = direction === "buy" ? currentPrice * 0.99 : currentPrice * 1.01;
        } else if (type === "stop") {
          target = direction === "buy" ? currentPrice * 1.01 : currentPrice * 0.99;
        }

        openTrade(direction, {
          amount: 100 + Math.floor(Math.random() * 400),
          orderType: type,
          targetPrice: parseFloat(target.toFixed(2)),
          stopLoss: 2 + Math.floor(Math.random() * 5),
          takeProfit: 5 + Math.floor(Math.random() * 10),
          pattern: "AI Bot Strategy"
        });
      }, 15000); // Trade every 15 seconds
    } else {
      if (aiBotIntervalRef.current) clearInterval(aiBotIntervalRef.current);
    }
    return () => {
      if (aiBotIntervalRef.current) clearInterval(aiBotIntervalRef.current);
    };
  }, [isAiBotEnabled, user, currentPrice, trades.length]);

  const handleDeposit = async (type: 'demo' | 'mpesa') => {
    if (!user) return;
    setIsDepositing(true);
    try {
      if (type === 'demo') {
        await fetch("/api/deposit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.uid, phone: "DEMO", amount: depositAmount, isDemo: true }),
        });
        setAiSuggestion(`Successfully added KES ${depositAmount} demo funds!`);
        setTimeout(() => setAiSuggestion(null), 3000);
      } else {
        const phone = prompt("Enter phone number (254...):");
        if (phone) {
          await fetch("/api/deposit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: user.uid, phone, amount: depositAmount }),
          });
          alert("Deposit initiated! Check your phone for M-Pesa prompt.");
        }
      }
      setShowDepositModal(false);
    } catch (e) {
      console.error("Deposit Error:", e);
      setError("Failed to process deposit");
    } finally {
      setIsDepositing(false);
    }
  };

  const chartData = [
    ...candles,
    ...(currentCandle && currentCandle.open ? [{
      time: currentCandle.time!,
      open: currentCandle.open!,
      high: currentCandle.high!,
      low: currentCandle.low!,
      close: currentPrice,
      isUp: currentPrice >= currentCandle.open!
    }] : [])
  ].map((c, i, arr) => {
    // Simple 9-period EMA calculation
    const period = 9;
    const k = 2 / (period + 1);
    let ema = c.close;
    if (i > 0 && arr[i-1].ema) {
      ema = c.close * k + arr[i-1].ema * (1 - k);
    }
    
    return {
      ...c,
      body: [Math.min(c.open, c.close), Math.max(c.open, c.close)],
      wick: [c.low, c.high],
      ema: ema
    };
  });

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-slate-800 p-8 rounded-2xl shadow-2xl text-center max-w-md w-full border border-slate-700"
        >
          <TrendingUp className="w-16 h-16 text-emerald-400 mx-auto mb-6" />
          <h1 className="text-3xl font-bold text-white mb-2">ZuriTrade FX</h1>
          <p className="text-slate-400 mb-8">The ultimate real-time FX trading arena. Test your skills and climb the leaderboard.</p>
          <button 
            onClick={handleLogin}
            className="w-full bg-emerald-500 hover:bg-emerald-600 text-slate-900 font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            <User className="w-5 h-5" />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Global Trade Marquee */}
      <div className="bg-slate-900/90 border-b border-slate-800 py-2 overflow-hidden whitespace-nowrap sticky top-0 z-50 backdrop-blur-md">
        <div className="flex">
          <motion.div 
            animate={{ x: ["0%", "-50%"] }}
            transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
            className="flex gap-12 items-center px-4"
          >
            {globalTrades.length > 0 ? (
              // Duplicate the list for a seamless loop
              [...globalTrades, ...globalTrades].map((t, i) => {
                const profit = t.exitPrice ? (t.direction === 'buy' ? t.exitPrice - t.entry : t.entry - t.exitPrice) * (t.amount / 100) : 0;
                return (
                  <div key={`${t.id}-${i}`} className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-widest">
                    <div className="flex items-center gap-1.5">
                      <User className="w-3 h-3 text-slate-500" />
                      <span className="text-slate-400">#{t.userId?.slice(0, 4) || '????'}</span>
                    </div>
                    <div className={`px-1.5 py-0.5 rounded ${t.direction === 'buy' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                      {t.direction}
                    </div>
                    <span className="text-slate-300">KES {t.amount}</span>
                    <span className={`font-mono ${profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {profit >= 0 ? '+' : ''}{profit.toFixed(2)}
                    </span>
                    <span className={`text-[8px] px-1 rounded ${t.status === 'open' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                      {t.status === 'open' ? 'LIVE' : 'SETTLED'}
                    </span>
                    <div className="w-1 h-1 bg-slate-700 rounded-full mx-2" />
                  </div>
                );
              })
            ) : (
              <div className="flex items-center gap-4 text-slate-500 text-[10px] uppercase tracking-[0.2em]">
                <RefreshCcw className="w-3 h-3 animate-spin" />
                Waiting for live arena trades...
              </div>
            )}
          </motion.div>
        </div>
      </div>

      <div className="p-4 md:p-8">
        <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-2xl shadow-black/50">
          <div className="flex items-center gap-4">
            {onBack && (
              <button 
                onClick={onBack}
                className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors border border-transparent hover:border-slate-700"
              >
                <Globe className="w-5 h-5" />
              </button>
            )}
            <div className="flex items-center gap-3">
              <div className="bg-gradient-to-br from-indigo-500 to-emerald-500 p-2 rounded-lg shadow-lg shadow-indigo-500/20">
                <TrendingUp className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-black tracking-tighter text-white">mosinhioTrade</h1>
                <p className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">Arena Round #{roundId}</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="text-right hidden sm:block">
              <div className="flex items-center gap-2 justify-end">
                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Equity Balance</p>
                <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded font-bold uppercase tracking-tighter">Demo</span>
              </div>
              <p className="text-2xl font-black text-emerald-400 tabular-nums">KES {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
            
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setShowDepositModal(true)}
                className="bg-slate-800 hover:bg-slate-700 p-3 rounded-xl transition-all border border-slate-700 hover:border-slate-600 active:scale-95"
                title="Deposit"
              >
                <Wallet className="w-5 h-5 text-indigo-400" />
              </button>
              <button 
                onClick={() => auth.signOut()}
                className="bg-slate-800 hover:bg-rose-500/20 p-3 rounded-xl transition-all border border-slate-700 hover:border-rose-500/30 group active:scale-95"
                title="Logout"
              >
                <User className="w-5 h-5 text-slate-400 group-hover:text-rose-400" />
              </button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Chart Area */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 h-[400px] relative">
              <div className="absolute top-6 right-6 z-10 text-right">
                <p className="text-xs text-slate-400 uppercase">Live Price</p>
                <p className={`text-3xl font-bold font-mono ${currentPrice >= 100 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {currentPrice.toFixed(2)}
                </p>
              </div>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart 
                  barGap={-12}
                  data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="time" hide />
                  <YAxis domain={['auto', 'auto']} hide />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }}
                    labelStyle={{ color: '#94a3b8' }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg shadow-xl text-xs space-y-1">
                            <p className="text-slate-400 font-mono mb-2">{data.time}</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                              <span className="text-slate-500">O:</span> <span className="text-slate-200 font-mono">{data.open.toFixed(2)}</span>
                              <span className="text-slate-500">H:</span> <span className="text-emerald-400 font-mono">{data.high.toFixed(2)}</span>
                              <span className="text-slate-500">L:</span> <span className="text-rose-400 font-mono">{data.low.toFixed(2)}</span>
                              <span className="text-slate-500">C:</span> <span className="text-slate-200 font-mono">{data.close.toFixed(2)}</span>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar 
                    dataKey="wick" 
                    barSize={1} 
                    fill="#475569" 
                  />
                  <Bar 
                    dataKey="body" 
                    barSize={12}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.isUp ? '#10b981' : '#f43f5e'} />
                    ))}
                  </Bar>
                  <Line 
                    type="monotone" 
                    dataKey="ema" 
                    stroke="#6366f1" 
                    strokeWidth={1} 
                    dot={false} 
                    strokeDasharray="5 5"
                  />
                  <ReferenceLine 
                    y={currentPrice} 
                    stroke="#94a3b8" 
                    strokeDasharray="3 3" 
                    label={{ 
                      position: 'right', 
                      value: currentPrice.toFixed(2), 
                      fill: '#94a3b8', 
                      fontSize: 10,
                      fontWeight: 'bold'
                    }} 
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Active Trades */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <RefreshCcw className="w-5 h-5 text-emerald-400" />
                Active Trades
              </h3>
              <div className="space-y-3">
                {trades.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 italic">No active trades in this round</p>
                ) : (
                  trades.map((t, i) => (
                    <div key={i} className={`flex items-center justify-between p-4 rounded-xl border ${
                      t.status === 'pending' ? 'bg-amber-500/5 border-amber-500/20' : 'bg-slate-800/50 border-slate-700/50'
                    }`}>
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          {t.direction === 'buy' ? (
                            <ArrowUpCircle className={`w-6 h-6 ${t.status === 'pending' ? 'text-amber-400/50' : 'text-emerald-400'}`} />
                          ) : (
                            <ArrowDownCircle className={`w-6 h-6 ${t.status === 'pending' ? 'text-amber-400/50' : 'text-rose-400'}`} />
                          )}
                          {t.status === 'pending' && (
                            <div className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-bold uppercase text-sm">{t.direction}</p>
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                              t.status === 'pending' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700 text-slate-300'
                            }`}>
                              {t.orderType || 'market'}
                            </span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-slate-400">
                                {t.status === 'pending' ? 'Target' : 'Entry'}: {t.entry.toFixed(2)}
                              </p>
                              {t.pattern && t.pattern !== 'None' && (
                                <span className="text-[9px] text-slate-500 font-mono italic">
                                  [{t.pattern}]
                                </span>
                              )}
                            </div>
                            {(t.stopLoss || t.takeProfit) && (
                              <div className="flex items-center gap-1.5">
                                {t.stopLoss && (
                                  <span className="text-[9px] font-bold text-rose-400/70">
                                    SL {t.stopLoss}%
                                  </span>
                                )}
                                {t.takeProfit && (
                                  <span className="text-[9px] font-bold text-emerald-400/70">
                                    TP {t.takeProfit}%
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-sm">KES {t.amount}</p>
                        {t.status === 'open' ? (
                          <p className={`text-xs font-mono ${t.direction === 'buy' ? (currentPrice > t.entry ? 'text-emerald-400' : 'text-rose-400') : (currentPrice < t.entry ? 'text-emerald-400' : 'text-rose-400')}`}>
                            {((t.direction === 'buy' ? currentPrice - t.entry : t.entry - currentPrice) * (t.amount / 100)).toFixed(2)}
                          </p>
                        ) : (
                          <p className="text-[10px] text-amber-400 font-bold uppercase animate-pulse">Pending</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Trade History */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <RefreshCcw className="w-5 h-5 text-amber-400" />
                Trade History
              </h3>
              <div className="space-y-3">
                {tradeHistory.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 italic">No trade history yet</p>
                ) : (
                  tradeHistory.map((t) => {
                    const profit = t.exitPrice ? (t.direction === 'buy' ? t.exitPrice - t.entry : t.entry - t.exitPrice) * (t.amount / 100) : 0;
                    return (
                      <div key={t.id} className="flex items-center justify-between bg-slate-800/30 p-4 rounded-xl border border-slate-700/30">
                        <div className="flex items-center gap-3">
                          {t.direction === 'buy' ? (
                            <ArrowUpCircle className="w-5 h-5 text-emerald-400/50" />
                          ) : (
                            <ArrowDownCircle className="w-5 h-5 text-rose-400/50" />
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold uppercase text-xs">{t.direction}</p>
                              {t.pattern && t.pattern !== 'None' && (
                                <span className="text-[8px] text-slate-500 font-mono italic">
                                  [{t.pattern}]
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-500">
                              {t.entry.toFixed(2)} → {t.exitPrice?.toFixed(2)}
                            </p>
                            {t.closeReason && (
                              <p className={`text-[9px] font-bold uppercase tracking-tight mt-1 px-1.5 py-0.5 rounded-md inline-block ${
                                t.closeReason.includes('Stop Loss') ? 'bg-rose-500/20 text-rose-400' : 
                                t.closeReason.includes('Take Profit') ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                              }`}>
                                {t.closeReason}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold">KES {t.amount}</p>
                          <p className={`text-xs font-bold ${profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {profit >= 0 ? '+' : ''}{profit.toFixed(2)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Side Panel */}
          <div className="space-y-6">
            {/* Trade Controls */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 space-y-4">
              <h3 className="text-lg font-bold">Place Trade</h3>
              {error && (
                <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 p-3 rounded-lg text-sm">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <label className="text-xs text-slate-400 uppercase font-bold">Amount (KES)</label>
                <input 
                  type="number" 
                  value={tradeAmount}
                  onChange={(e) => setTradeAmount(Number(e.target.value))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-xl font-bold focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-500 uppercase font-bold">Stop Loss %</label>
                  <input 
                    type="number" 
                    value={stopLoss}
                    onChange={(e) => setStopLoss(Number(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-sm focus:outline-none focus:border-rose-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-500 uppercase font-bold">Take Profit %</label>
                  <input 
                    type="number" 
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(Number(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-sm focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="space-y-4 pt-2 border-t border-slate-800">
                <div className="space-y-2">
                  <label className="text-[10px] text-slate-500 uppercase font-bold">Order Type</label>
                  <div className="grid grid-cols-3 gap-2">
                    {['market', 'limit', 'stop'].map((type) => (
                      <button
                        key={type}
                        onClick={() => setOrderType(type as any)}
                        className={`py-2 text-[10px] font-bold uppercase rounded-lg border transition-all ${
                          orderType === type 
                            ? 'bg-slate-700 border-slate-600 text-white' 
                            : 'bg-slate-800/50 border-slate-800 text-slate-500 hover:border-slate-700'
                        }`}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                </div>

                {orderType !== 'market' && (
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase font-bold">Target Price</label>
                    <div className="relative">
                      <input 
                        type="number" 
                        step="0.01"
                        value={targetPrice}
                        onChange={(e) => setTargetPrice(Number(e.target.value))}
                        className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-lg font-bold focus:outline-none focus:border-amber-500 transition-colors"
                      />
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 font-mono">
                        CUR: {currentPrice.toFixed(2)}
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Trade Pattern</label>
                      <button 
                        onClick={() => setShowPatternLibrary(true)}
                        className="text-[9px] text-slate-500 hover:text-slate-300 underline"
                      >
                        Library
                      </button>
                    </div>
                    <button 
                      onClick={scanPatterns}
                      disabled={isScanning}
                      className="text-[9px] font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full transition-all disabled:opacity-50"
                    >
                      {isScanning ? <RefreshCcw className="w-2 h-2 animate-spin" /> : <TrendingUp className="w-2 h-2" />}
                      AI SCAN
                    </button>
                  </div>
                  <select
                    value={selectedPattern}
                    onChange={(e) => setSelectedPattern(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-xs font-bold focus:outline-none focus:border-emerald-500 transition-colors appearance-none"
                  >
                    {TRADE_PATTERNS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  {aiSuggestion && (
                    <p className="text-[9px] text-emerald-400 font-mono italic animate-pulse">
                      AI Suggestion: {aiSuggestion}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button 
                  onClick={() => openTrade('buy')}
                  className="bg-emerald-500 hover:bg-emerald-600 text-slate-900 font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20"
                >
                  BUY
                </button>
                <button 
                  onClick={() => openTrade('sell')}
                  className="bg-rose-500 hover:bg-rose-600 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-rose-500/20"
                >
                  SELL
                </button>
              </div>

              {/* AI Bot Toggle */}
              <div className="pt-4 border-t border-slate-800">
                <div className="flex items-center justify-between bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${isAiBotEnabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                      <RefreshCcw className={`w-4 h-4 ${isAiBotEnabled ? 'animate-spin' : ''}`} />
                    </div>
                    <div>
                      <p className="text-sm font-bold">AI Trading Bot</p>
                      <p className="text-[10px] text-slate-500">Auto-test all trade options</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setIsAiBotEnabled(!isAiBotEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${isAiBotEnabled ? 'bg-emerald-500' : 'bg-slate-700'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isAiBotEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-slate-500 text-center uppercase tracking-widest">Trades settle every 30 seconds</p>
            </div>

            {/* Leaderboard */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-400" />
                Leaderboard
              </h3>
              <div className="space-y-4">
                {leaderboard.map((player, i) => (
                  <div key={player.userId} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold w-5 ${i === 0 ? 'text-amber-400' : 'text-slate-500'}`}>
                        {i + 1}
                      </span>
                      <p className="text-sm font-medium truncate max-w-[100px]">
                        {player.userId.slice(0, 8)}...
                      </p>
                    </div>
                    <p className="text-sm font-bold text-emerald-400">KES {player.balance.toFixed(0)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Deposit Modal */}
      <AnimatePresence>
        {showDepositModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-emerald-400" />
                  Deposit Funds
                </h2>
                <button 
                  onClick={() => setShowDepositModal(false)}
                  className="text-slate-500 hover:text-white p-2"
                >
                  ✕
                </button>
              </div>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs text-slate-400 uppercase font-bold">Amount (KES)</label>
                  <input 
                    type="number" 
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(Number(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-2xl font-bold focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => handleDeposit('demo')}
                    disabled={isDepositing}
                    className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-4 rounded-xl transition-all border border-slate-700 flex flex-col items-center gap-1"
                  >
                    <span className="text-sm">Demo Funds</span>
                    <span className="text-[10px] text-slate-500 font-normal">Instant Credit</span>
                  </button>
                  <button 
                    onClick={() => handleDeposit('mpesa')}
                    disabled={isDepositing}
                    className="bg-emerald-500 hover:bg-emerald-600 text-slate-900 font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 flex flex-col items-center gap-1"
                  >
                    <span className="text-sm">M-Pesa</span>
                    <span className="text-[10px] text-emerald-900/60 font-normal">STK Push</span>
                  </button>
                </div>
                
                <p className="text-[10px] text-slate-500 text-center italic">
                  Demo funds are for practice only and have no real-world value.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Pattern Library Modal */}
      <AnimatePresence>
        {showPatternLibrary && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-emerald-400" />
                  Trade Pattern Library
                </h2>
                <button 
                  onClick={() => setShowPatternLibrary(false)}
                  className="text-slate-500 hover:text-white p-2"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-4">
                {Object.entries(PATTERN_DESCRIPTIONS).map(([name, desc]) => (
                  <div key={name} className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                    <h4 className="font-bold text-emerald-400 text-sm mb-1">{name}</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
