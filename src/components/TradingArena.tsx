import React, { Component, useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { 
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine 
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Trophy, User, ArrowUpCircle, ArrowDownCircle, RefreshCcw, Globe, Info, Zap, BarChart3, Clock, Brain, Camera } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { auth, db } from "../firebase";
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { doc, onSnapshot, collection, query, where, orderBy, limit } from "firebase/firestore";

// --- Interfaces ---
interface PriceData {
  time: string;
  price: number;
}

interface LeaderboardEntry {
  userId: string;
  balance: number;
  name?: string;
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
  executionLatency?: number;
  confirmedAt?: number;
  duration?: "30s" | "5m" | "30m";
  isBot?: boolean;
  leverage?: number;
  commission?: number;
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

// --- Error Handling ---
const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
} as const;

type OperationType = 'create' | 'update' | 'delete' | 'list' | 'get' | 'write';

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw here to avoid breaking the UI, but we log it
}

class ErrorBoundary extends Component<any, any> {
  state: any;
  props: any;
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const isQuotaError = this.state.error?.message?.includes("quota") || this.state.error?.code === "resource-exhausted";
      return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-center">
          <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl max-w-md shadow-2xl">
            <div className="w-16 h-16 bg-rose-500/10 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <RefreshCcw className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-4">
              {isQuotaError ? "Quota Limit Reached" : "Something went wrong"}
            </h1>
            <p className="text-slate-400 mb-8 leading-relaxed">
              {isQuotaError 
                ? "The application has reached its free tier limit for today. Live data and trading will resume once the quota resets at midnight UTC."
                : "An unexpected error occurred. Please try refreshing the page."}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-4 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-2xl transition-all shadow-lg shadow-indigo-500/20"
            >
              REFRESH PAGE
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function TradingArenaWithErrorBoundary(props: TradingArenaProps) {
  return (
    <ErrorBoundary>
      <TradingArena {...props} />
    </ErrorBoundary>
  );
}

function TradingArena({ onBack }: TradingArenaProps) {
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
  const [leverage, setLeverage] = useState<number>(1);
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
  const [aiBotAmount, setAiBotAmount] = useState<number>(500);
  const [aiBotStopLoss, setAiBotStopLoss] = useState<number>(5);
  const [aiBotTakeProfit, setAiBotTakeProfit] = useState<number>(10);
  const [aiBotOrderType, setAiBotOrderType] = useState<"market" | "limit" | "stop">("market");
  const [aiAnalysis, setAiAnalysis] = useState<{
    sentiment: "Bullish" | "Bearish" | "Neutral";
    prediction: string;
    recommendation: string;
    reasoning: string;
  } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingTrade, setPendingTrade] = useState<any>(null);
  const [activeLeaderIndex, setActiveLeaderIndex] = useState(0);
  const [nextSettlementAt, setNextSettlementAt] = useState<number>(Date.now() + 7000);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionCountdown, setExecutionCountdown] = useState(0);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const aiAnalysisRef = useRef(aiAnalysis);
  const [tradeDuration, setTradeDuration] = useState<"30s" | "5m" | "30m">("30s");
  const [priceAlerts, setPriceAlerts] = useState<{ id: string; price: number; type: "above" | "below" }[]>([]);
  const [alertPrice, setAlertPrice] = useState<number>(100);
  const [arenaEvents, setArenaEvents] = useState<{ id: string; message: string; type: 'info' | 'success' | 'danger' | 'warning'; time: string }[]>([]);
  const [activityTab, setActivityTab] = useState<"my" | "global">("my");
  const [limitPrice, setLimitPrice] = useState<number>(100);
  const [filterStatus, setFilterStatus] = useState<"all" | "open" | "closed" | "pending">("all");
  const [filterDirection, setFilterDirection] = useState<"all" | "buy" | "sell">("all");
  const [filterStartDate, setFilterStartDate] = useState<string>("");
  const [filterEndDate, setFilterEndDate] = useState<string>("");
  const [filterDuration, setFilterDuration] = useState<"all" | "30s" | "5m" | "30m">("all");
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState(1000);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isRenewing, setIsRenewing] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [isPremium, setIsPremium] = useState(false);
  const [showPremiumModal, setShowPremiumModal] = useState(false);
  const [oneClickTrading, setOneClickTrading] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; message: string; type: 'success' | 'error' | 'info' }[]>([]);
  const [phone, setPhone] = useState("");
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
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user) {
      const s = io(window.location.origin);
      setSocket(s);
      s.emit("register", user.uid);

      s.on("priceUpdate", (data: { price: number; roundId: number; nextSettlementAt: number }) => {
        setCurrentPrice(data.price);
        setRoundId(data.roundId);
        setNextSettlementAt(data.nextSettlementAt);
        
        setPriceHistory((prev) => {
          const newHistory = [...prev, { time: new Date().toLocaleTimeString(), price: data.price }];
          return newHistory.slice(-30);
        });

        // Candlestick Logic (5-second candles)
        setCurrentCandle((prev) => {
          const now = new Date();
          const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          
          // Check Price Alerts
          const triggered = priceAlerts.filter(a => 
            (a.type === "above" && data.price >= a.price) || 
            (a.type === "below" && data.price <= a.price)
          );
          if (triggered.length > 0) {
            triggered.forEach(a => {
              console.log(`ALERT: Price reached ${a.price} (${a.type})`);
              addToast(`PRICE ALERT: Market reached ${a.price}!`, 'info');
            });
            setPriceAlerts(prevAlerts => prevAlerts.filter(a => !triggered.some(t => t.id === a.id)));
          }

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
        addToast(`${data.reason || 'Trade Closed'}! Profit: KES ${data.profit.toFixed(2)}`, data.profit >= 0 ? 'success' : 'error');
      });

      s.on("tradeOpened", (data: { tradeId: string, status: string, message: string }) => {
        addToast(data.message, data.status === 'open' ? 'success' : 'info');
      });

      s.on("userTradesUpdate", (data: { activeTrades: Trade[], tradeHistory: Trade[] }) => {
        setTrades(data.activeTrades);
        setTradeHistory(data.tradeHistory);
      });

      s.on("globalTradesUpdate", (data: Trade[]) => {
        setGlobalTrades(data);
      });

      s.on("profileUpdate", (data: any) => {
        if (data.name) setDisplayName(data.name);
        if (data.bio) setBio(data.bio);
        if (data.photoUrl) setPhotoUrl(data.photoUrl);
        if (data.isPremium !== undefined) setIsPremium(data.isPremium);
        if (data.oneClickTrading !== undefined) setOneClickTrading(data.oneClickTrading);
        if (data.aiBotAmount !== undefined) setAiBotAmount(data.aiBotAmount);
        if (data.aiBotStopLoss !== undefined) setAiBotStopLoss(data.aiBotStopLoss);
        if (data.aiBotTakeProfit !== undefined) setAiBotTakeProfit(data.aiBotTakeProfit);
        if (data.aiBotOrderType !== undefined) setAiBotOrderType(data.aiBotOrderType as any);
        if (data.isAiBotEnabled !== undefined) setIsAiBotEnabled(data.isAiBotEnabled);
      });

      s.on("leaderboardUpdate", (data: LeaderboardEntry[]) => setLeaderboard(data));
      
      s.on("arenaEvent", (event: any) => {
        setArenaEvents(prev => {
          if (prev.some(e => e.id === event.id)) return prev;
          return [event, ...prev].slice(0, 20);
        });
      });
      
      s.on("errorMsg", (msg: string) => setError(msg));

      return () => {
        s.disconnect();
        setSocket(null);
      };
    }
  }, [user?.uid]);

  // Rotate Active Leader every 1 minute
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveLeaderIndex((prev) => {
        const next = prev + 1;
        return next >= Math.min(leaderboard.length, 5) ? 0 : next;
      });
    }, 60000);
    return () => clearInterval(interval);
  }, [leaderboard.length]);

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

  const getAiAnalysis = async () => {
    if (!isPremium) {
      setShowPremiumModal(true);
      return;
    }
    if (candles.length < 10) {
      setError("Need at least 10 candles for deep AI analysis");
      return;
    }
    setIsAnalyzing(true);
    try {
      const { GoogleGenAI, Type } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const candleData = candles.map(c => `O:${c.open}, H:${c.high}, L:${c.low}, C:${c.close}`).join("\n");
      const recentPrice = currentPrice;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `As an expert FX trader, analyze the following recent 5-second candlestick data and current market price. Provide a detailed market analysis and prediction for the next 60 seconds.
        
        Current Price: ${recentPrice}
        Recent Candles:
        ${candleData}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              sentiment: { type: Type.STRING, "enum": ["Bullish", "Bearish", "Neutral"] },
              prediction: { type: Type.STRING, description: "Short prediction of price movement" },
              recommendation: { type: Type.STRING, description: "Buy, Sell, or Hold recommendation" },
              reasoning: { type: Type.STRING, description: "Detailed technical reasoning" }
            },
            required: ["sentiment", "prediction", "recommendation", "reasoning"]
          }
        }
      });

      const result = JSON.parse(response.text);
      setAiAnalysis(result);
    } catch (e) {
      console.error("AI Analysis Error:", e);
      setError("AI Analysis failed");
    } finally {
      setIsAnalyzing(false);
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

  const openTrade = (direction: "buy" | "sell", customParams?: Partial<Trade>, skipConfirm = false) => {
    if (!user || !socket) return;
    const amount = customParams?.amount || tradeAmount;
    if (amount > balance) {
      setError("Insufficient balance");
      return;
    }

    const tradeData = { 
      userId: user.uid, 
      direction, 
      amount: amount,
      leverage: leverage,
      stopLoss: customParams?.stopLoss ?? stopLoss,
      takeProfit: customParams?.takeProfit ?? takeProfit,
      orderType: customParams?.orderType ?? orderType,
      targetPrice: customParams?.targetPrice ?? targetPrice,
      pattern: customParams?.pattern ?? selectedPattern,
      duration: customParams?.duration ?? tradeDuration
    };

    if (skipConfirm || oneClickTrading) {
      socket.emit("openTrade", { ...tradeData, confirmedAt: Date.now() });
      setError(null);
    } else {
      setPendingTrade(tradeData);
      setShowConfirmModal(true);
    }
  };

  useEffect(() => {
    if (trades.length === 0 && globalTrades.length > 0) {
      setActivityTab("global");
    } else if (trades.length > 0) {
      setActivityTab("my");
    }
  }, [trades.length, globalTrades.length]);

  const unrealizedPL = trades.filter(t => t.status === 'open').reduce((acc, t) => {
    const profitPct = t.direction === 'buy' ? (currentPrice - t.entry) / t.entry * 100 : (t.entry - currentPrice) / t.entry * 100;
    return acc + (profitPct / 100) * t.amount * (t.leverage || 1);
  }, 0);
  const equity = balance + unrealizedPL;

  const handleConfirmTrade = () => {
    if (socket && pendingTrade) {
      setIsExecuting(true);
      let count = 2; // Reduced from 3
      setExecutionCountdown(count);
      
      const interval = setInterval(() => {
        count--;
        setExecutionCountdown(count);
        if (count <= 0) {
          clearInterval(interval);
          socket.emit("openTrade", { ...pendingTrade, confirmedAt: Date.now() });
          setPendingTrade(null);
          setShowConfirmModal(false);
          setIsExecuting(false);
          setError(null);
        }
      }, 300); // Reduced from 400ms
    }
  };

  const currentPriceRef = useRef(currentPrice);
  const tradesRef = useRef(trades);
  const balanceRef = useRef(balance);

  useEffect(() => {
    currentPriceRef.current = currentPrice;
  }, [currentPrice]);

  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  useEffect(() => {
    balanceRef.current = balance;
  }, [balance]);

  useEffect(() => {
    aiAnalysisRef.current = aiAnalysis;
  }, [aiAnalysis]);

  const aiBotAmountRef = useRef(aiBotAmount);
  const aiBotStopLossRef = useRef(aiBotStopLoss);
  const aiBotTakeProfitRef = useRef(aiBotTakeProfit);
  const aiBotOrderTypeRef = useRef(aiBotOrderType);

  useEffect(() => {
    aiBotAmountRef.current = aiBotAmount;
    aiBotStopLossRef.current = aiBotStopLoss;
    aiBotTakeProfitRef.current = aiBotTakeProfit;
    aiBotOrderTypeRef.current = aiBotOrderType;
  }, [aiBotAmount, aiBotStopLoss, aiBotTakeProfit, aiBotOrderType]);

  useEffect(() => {
    if (user?.email === "mosesmwai20@gmail.com") {
      setIsPremium(true);
      // Auto-enable bot for owner on login
      setTimeout(() => {
        setIsAiBotEnabled(true);
        addToast("Welcome back! AI Auto-Pilot engaged.", "info");
      }, 2000);
    }
  }, [user?.email]);

  // AI Bot Logic
  useEffect(() => {
    if (isAiBotEnabled && user) {
      // Periodically get AI Analysis if bot is enabled
      const analysisInterval = setInterval(() => {
        getAiAnalysis();
      }, 30000); // Every 30 seconds

      if (!isPremium) {
        setIsAiBotEnabled(false);
        setShowPremiumModal(true);
        clearInterval(analysisInterval);
        return;
      }
      console.log("AI Bot: Starting interval...");
      aiBotIntervalRef.current = setInterval(async () => {
        if (tradesRef.current.length >= 10) { // Increased limit for owner/demo
          console.log("AI Bot: Max trades reached, skipping...");
          return;
        }

        // 1. Scan for pattern (with fallback)
        let pattern = "AI Bot Strategy";
        try {
          console.log("AI Bot: Scanning market patterns...");
          await scanPatterns();
          if (aiSuggestion && TRADE_PATTERNS.includes(aiSuggestion)) {
            pattern = `AI Bot: ${aiSuggestion}`;
          }
        } catch (e) {
          console.warn("AI Bot: Scan failed, using fallback strategy", e);
        }
        
        // 2. Decide trade parameters based on Sentiment
        const sentiment = aiAnalysisRef.current?.sentiment || "Neutral";
        let direction: "buy" | "sell" = Math.random() > 0.5 ? "buy" : "sell";
        
        if (sentiment === "Bullish") direction = "buy";
        if (sentiment === "Bearish") direction = "sell";

        const type = aiBotOrderTypeRef.current;
        
        // Dynamic Parameter Adjustment
        let amount = aiBotAmountRef.current;
        let sl = aiBotStopLossRef.current;
        let tp = aiBotTakeProfitRef.current;

        // Analyze recent history (last 5 trades)
        const recentHistory = tradeHistory.slice(0, 5);
        const winCount = recentHistory.filter(t => {
          const profit = t.exitPrice ? (t.direction === 'buy' ? t.exitPrice - t.entry : t.entry - t.exitPrice) : 0;
          return profit > 0;
        }).length;
        const historyMultiplier = winCount >= 3 ? 1.2 : (winCount <= 1 ? 0.8 : 1.0);

        if (sentiment === "Bullish" || sentiment === "Bearish") {
          // Strong sentiment: Higher risk/reward
          amount = Math.min(amount * 1.5 * historyMultiplier, balanceRef.current * 0.25); 
          sl = Math.max(sl * 0.8, 2); 
          tp = tp * 2.5; 
          console.log(`AI Bot: Strong ${sentiment} sentiment detected. History Multiplier: ${historyMultiplier}. Boosting risk/reward.`);
        } else {
          // Neutral sentiment: Lower risk
          amount = amount * 0.5 * historyMultiplier;
          sl = sl * 0.5;
          tp = tp * 0.5;
          console.log(`AI Bot: Neutral sentiment. History Multiplier: ${historyMultiplier}. Reducing risk.`);
        }

        // Randomize target price for limit/stop orders based on current price
        const price = currentPriceRef.current;
        let target = price;
        if (type === "limit") {
          target = direction === "buy" ? price * 0.99 : price * 1.01;
        } else if (type === "stop") {
          target = direction === "buy" ? price * 1.01 : price * 0.99;
        }

        if (amount > balanceRef.current) {
          console.log("AI Bot: Insufficient balance, skipping...");
          return;
        }

        // Save these dynamic parameters to preferences (optional but requested)
        // We'll update the state which will trigger the ref updates and we can emit a profile update
        setAiBotAmount(Math.round(amount));
        setAiBotStopLoss(parseFloat(sl.toFixed(1)));
        setAiBotTakeProfit(parseFloat(tp.toFixed(1)));

        console.log(`AI Bot: Placing ${type} ${direction} order at ${target.toFixed(2)} with dynamic params: Amount=${amount.toFixed(0)}, SL=${sl}%, TP=${tp}%`);
        
        const eventId = generateId();
        setArenaEvents(prev => {
          if (prev.some(e => e.id === eventId)) return prev;
          return [{
            id: eventId,
            message: `AI Bot (Dynamic) placed ${type.toUpperCase()} ${direction.toUpperCase()} at KES ${target.toFixed(2)} [Sentiment: ${sentiment}]`,
            type: 'info',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          }, ...prev].slice(0, 20);
        });

        openTrade(direction, {
          amount: Math.round(amount),
          orderType: type,
          targetPrice: parseFloat(target.toFixed(2)),
          stopLoss: parseFloat(sl.toFixed(1)),
          takeProfit: parseFloat(tp.toFixed(1)),
          pattern: pattern
        }, true);

        // Persist to database
        if (socket && user) {
          socket.emit("updateProfile", {
            userId: user.uid,
            aiBotAmount: Math.round(amount),
            aiBotStopLoss: parseFloat(sl.toFixed(1)),
            aiBotTakeProfit: parseFloat(tp.toFixed(1))
          });
        }

      }, user?.email === "mosesmwai20@gmail.com" ? 5000 : 15000); // Trade every 5s for owner, 15s for others

      return () => {
        clearInterval(analysisInterval);
        if (aiBotIntervalRef.current) clearInterval(aiBotIntervalRef.current);
      };
    } else {
      if (aiBotIntervalRef.current) {
        console.log("AI Bot: Stopping interval...");
        clearInterval(aiBotIntervalRef.current);
      }
    }
  }, [isAiBotEnabled, user]);

  const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = generateId();
    setToasts(prev => {
      if (prev.some(t => t.id === id)) return prev;
      return [...prev, { id, message, type }];
    });
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  const cancelTrade = (tradeId: string) => {
    if (socket && user) {
      socket.emit("cancelTrade", { tradeId, userId: user.uid });
      addToast("Cancellation request sent", "info");
    }
  };

  const updateProfile = () => {
    if (socket && user) {
      socket.emit("updateProfile", { 
        userId: user.uid, 
        name: displayName,
        bio: bio,
        photoUrl: photoUrl,
        oneClickTrading: oneClickTrading,
        aiBotAmount: aiBotAmount,
        aiBotStopLoss: aiBotStopLoss,
        aiBotTakeProfit: aiBotTakeProfit,
        aiBotOrderType: aiBotOrderType,
        isAiBotEnabled: isAiBotEnabled
      });
      setShowProfileModal(false);
      addToast("Profile update sent", "info");
    }
  };

  const upgradeToPremium = () => {
    if (socket && user) {
      socket.emit("upgradePremium", { userId: user.uid });
      setShowPremiumModal(false);
    }
  };

  const handleWithdraw = async () => {
    if (!user || !phone) {
      setError("Phone number required for withdrawal");
      return;
    }
    setIsWithdrawing(true);
    try {
      const res = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.uid, amount: withdrawAmount, phone }),
      });
      const data = await res.json();
      if (data.status === "success") {
        addToast(`Withdrawal of KES ${withdrawAmount} successful!`, "success");
        setShowWithdrawModal(false);
      } else {
        setError(data.message);
        addToast(data.message, "error");
      }
    } catch (e) {
      console.error("Withdrawal Error:", e);
      setError("Withdrawal failed");
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleRenewBalance = async () => {
    if (!user) return;
    setIsRenewing(true);
    try {
      const res = await fetch("/api/renew-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.uid }),
      });
      const data = await res.json();
      if (data.status === "success") {
        addToast("Balance renewed to KES 10,000!", "success");
      } else {
        addToast(data.message, "error");
      }
    } catch (e) {
      console.error("Renewal Error:", e);
      addToast("Failed to renew balance", "error");
    } finally {
      setIsRenewing(false);
    }
  };

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
        if (!phone || phone.length < 10) {
          setError("Please enter a valid phone number");
          return;
        }
        await fetch("/api/deposit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.uid, phone, amount: depositAmount }),
        });
        setAiSuggestion("STK Push initiated! Check your phone.");
        setTimeout(() => setAiSuggestion(null), 5000);
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
    if (i > 0 && (arr[i-1] as any).ema) {
      ema = c.close * k + (arr[i-1] as any).ema * (1 - k);
    }
    
    return {
      ...c,
      body: [Math.min(c.open, c.close), Math.max(c.open, c.close)],
      wick: [c.low, c.high],
      ema: ema
    };
  });

  const filteredTradeHistory = React.useMemo(() => {
    return [...trades, ...tradeHistory].filter((t) => {
      const statusMatch = filterStatus === "all" || t.status === filterStatus;
      const directionMatch = filterDirection === "all" || t.direction === filterDirection;
      const durationMatch = filterDuration === "all" || t.duration === filterDuration;
      
      let dateMatch = true;
      if (t.createdAt) {
        const tradeDate = t.createdAt.seconds ? new Date(t.createdAt.seconds * 1000) : new Date(t.createdAt);
        if (filterStartDate) {
          const start = new Date(filterStartDate);
          start.setHours(0, 0, 0, 0);
          if (tradeDate < start) dateMatch = false;
        }
        if (filterEndDate) {
          const end = new Date(filterEndDate);
          end.setHours(23, 59, 59, 999);
          if (tradeDate > end) dateMatch = false;
        }
      }

      return statusMatch && directionMatch && durationMatch && dateMatch;
    }).sort((a, b) => {
      const timeA = a.createdAt?.seconds || (a.createdAt ? new Date(a.createdAt).getTime() / 1000 : 0);
      const timeB = b.createdAt?.seconds || (b.createdAt ? new Date(b.createdAt).getTime() / 1000 : 0);
      return timeB - timeA;
    });
  }, [trades, tradeHistory, filterStatus, filterDirection, filterDuration, filterStartDate, filterEndDate]);

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
                const profitPct = t.exitPrice ? (t.direction === 'buy' ? (t.exitPrice - t.entry) / t.entry : (t.entry - t.exitPrice) / t.entry) : 0;
                const profit = profitPct * t.amount * (t.leverage || 1);
                return (
                  <div key={`${t.id}-${i}`} className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-widest">
                    <div className="flex items-center gap-1.5">
                      {t.isBot ? (
                        <Zap className="w-3 h-3 text-amber-400 fill-amber-400/20" />
                      ) : (
                        <User className="w-3 h-3 text-indigo-400" />
                      )}
                      <span className="text-slate-400">{t.userId?.slice(0, 8) || '????'}</span>
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
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-black tracking-tighter text-white">mosinhioTrade</h1>
                  {isPremium && (
                    <span className="bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-[8px] font-black px-2 py-0.5 rounded-full shadow-lg shadow-indigo-500/20 flex items-center gap-1">
                      <Trophy className="w-2 h-2" />
                      PREMIUM
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">Arena Round #{roundId}</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-8 mr-4 border-r border-slate-800 pr-8 hidden lg:flex">
              <div className="text-right">
                <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Active Trades</p>
                <p className="text-sm font-black text-emerald-400">{trades.filter(t => t.status === 'open').length + globalTrades.filter(t => t.status === 'open').length}</p>
              </div>
            </div>

            <div className="text-right hidden sm:block">
              <div className="flex items-center gap-2 justify-end">
                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Equity Balance</p>
                <button 
                  onClick={handleRenewBalance}
                  disabled={isRenewing}
                  className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded font-bold uppercase tracking-tighter hover:bg-amber-500/20 transition-all disabled:opacity-50"
                  title="Renew balance (Every 24h)"
                >
                  {isRenewing ? '...' : 'Renew'}
                </button>
                <span className="text-[9px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.5 rounded font-bold uppercase tracking-tighter">Demo</span>
              </div>
              <p className={`text-2xl font-black tabular-nums ${equity >= balance ? 'text-emerald-400' : 'text-rose-400'}`}>
                KES {equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <div className="flex items-center gap-2 justify-end mt-0.5">
                <p className="text-[9px] text-slate-500 uppercase font-bold">Margin: KES {balance.toLocaleString()}</p>
                <p className={`text-[9px] font-bold ${unrealizedPL >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {unrealizedPL >= 0 ? '+' : ''}{unrealizedPL.toLocaleString()} P/L
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button 
                onClick={() => {
                  if (!isPremium) {
                    setShowPremiumModal(true);
                  } else {
                    setIsAiBotEnabled(!isAiBotEnabled);
                    addToast(isAiBotEnabled ? "Auto-Pilot Disengaged" : "AI Auto-Pilot Engaged", "info");
                  }
                }}
                className={`p-3 rounded-xl transition-all border active:scale-95 ${isAiBotEnabled ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700'}`}
                title={isAiBotEnabled ? "Stop Auto-Pilot" : "Start AI Auto-Pilot"}
              >
                <RefreshCcw className={`w-5 h-5 ${isAiBotEnabled ? 'animate-spin' : ''}`} />
              </button>
              <button 
                onClick={() => setShowPremiumModal(true)}
                className={`p-3 rounded-xl transition-all border active:scale-95 ${isPremium ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700'}`}
                title="Premium Status"
              >
                <Trophy className="w-5 h-5" />
              </button>
              <button 
                onClick={() => setShowDepositModal(true)}
                className="bg-slate-800 hover:bg-slate-700 p-3 rounded-xl transition-all border border-slate-700 hover:border-slate-600 active:scale-95"
                title="Deposit"
              >
                <Wallet className="w-5 h-5 text-indigo-400" />
              </button>
              <button 
                onClick={() => setShowWithdrawModal(true)}
                className="bg-slate-800 hover:bg-slate-700 p-3 rounded-xl transition-all border border-slate-700 hover:border-slate-600 active:scale-95"
                title="Withdraw"
              >
                <TrendingDown className="w-5 h-5 text-rose-400" />
              </button>
              <button 
                onClick={() => setShowProfileModal(true)}
                className="bg-slate-800 hover:bg-slate-700 p-3 rounded-xl transition-all border border-slate-700 hover:border-slate-600 active:scale-95"
                title="Profile Settings"
              >
                <User className="w-5 h-5 text-amber-400" />
              </button>
              <button 
                onClick={() => auth.signOut()}
                className="bg-slate-800 hover:bg-rose-500/20 p-3 rounded-xl transition-all border border-slate-700 hover:border-rose-500/30 group active:scale-95"
                title="Logout"
              >
                <RefreshCcw className="w-5 h-5 text-slate-400 group-hover:text-rose-400" />
              </button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Chart Area */}
          <div className="lg:col-span-2 space-y-6">
            {/* News Ticker */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-2 overflow-hidden relative">
              <div className="flex items-center gap-4 whitespace-nowrap animate-marquee">
                {arenaEvents.filter(e => e.message.startsWith('NEWS:')).slice(-5).map(e => (
                  <div key={e.id} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${e.type === 'warning' ? 'bg-amber-400' : 'bg-indigo-400'}`} />
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">{e.message}</span>
                    <span className="text-[9px] text-slate-500 font-mono">{e.time}</span>
                    <span className="mx-4 text-slate-700">|</span>
                  </div>
                ))}
                {arenaEvents.filter(e => e.message.startsWith('NEWS:')).length === 0 && (
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Waiting for market news...</span>
                  </div>
                )}
              </div>
            </div>

            {/* Live Trade Feed Marquee */}
            <div className="bg-slate-900/30 border border-slate-800/50 rounded-xl p-2 overflow-hidden relative">
              <div className="flex items-center gap-6 whitespace-nowrap animate-marquee-slow">
                <span className="text-[9px] font-black text-emerald-500 uppercase tracking-tighter bg-emerald-500/10 px-2 py-0.5 rounded">Live Arena Feed</span>
                {globalTrades.slice(0, 10).map((t, i) => (
                  <div key={t.id || i} className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold ${t.direction === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {t.direction === 'buy' ? '▲' : '▼'} {t.userId.slice(0, 6)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">KES {t.amount.toLocaleString()}</span>
                    {t.isBot && <Zap className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />}
                    <span className="mx-2 text-slate-800">/</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 h-[400px] relative overflow-hidden">
              {/* Background Glow */}
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(99,102,241,0.08),transparent)] pointer-events-none" />
              
              {/* Technical Grid Pattern */}
              <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:40px_40px] opacity-20 pointer-events-none" />
              
              <div className="absolute top-6 left-6 z-10 flex items-center gap-2">
                <div className="flex items-center gap-1.5 bg-indigo-500/10 px-2 py-1 rounded-md border border-indigo-500/20 group cursor-help relative">
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full" />
                  <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">EMA (9)</span>
                  <Info className="w-3 h-3 text-indigo-400/50 group-hover:text-indigo-400 transition-colors" />
                  
                  {/* Tooltip content */}
                  <div className="absolute top-full left-0 mt-2 w-64 p-3 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 pointer-events-none">
                    <p className="text-[11px] font-bold text-indigo-400 mb-1 uppercase tracking-tight">Exponential Moving Average</p>
                    <p className="text-[10px] text-slate-300 leading-relaxed mb-2">
                      A technical indicator that tracks price trends by giving more weight to recent data. It reacts faster to price changes than a simple moving average.
                    </p>
                    <div className="pt-2 border-t border-slate-800">
                      <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">Calculation</p>
                      <code className="text-[9px] text-indigo-300/80 font-mono block bg-slate-950 p-1.5 rounded">
                        EMA = (Close - PrevEMA) * Multiplier + PrevEMA
                        <br />
                        Multiplier = 2 / (9 + 1) = 0.2
                      </code>
                    </div>
                  </div>
                </div>
              </div>

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
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={true} opacity={0.4} />
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
                              {data.ema && (
                                <>
                                  <span className="text-indigo-400/70">EMA:</span> 
                                  <span className="text-indigo-400 font-mono">{data.ema.toFixed(2)}</span>
                                </>
                              )}
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
                  {/* Active Trade Markers */}
                  {trades.filter(t => t.status === 'open').map((t, i) => (
                    <ReferenceLine 
                      key={t.id || i}
                      y={t.entry} 
                      stroke={t.direction === 'buy' ? '#10b981' : '#f43f5e'} 
                      strokeWidth={1}
                      opacity={0.5}
                      label={{ 
                        position: 'left', 
                        value: `${t.direction.toUpperCase()} @ ${t.entry.toFixed(2)}`, 
                        fill: t.direction === 'buy' ? '#10b981' : '#f43f5e', 
                        fontSize: 8,
                        fontWeight: 'bold'
                      }} 
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Market Sentiment Gauge */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Market Sentiment</p>
                  <div className="flex items-center gap-2">
                    <div className="flex h-1.5 w-32 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-rose-500" style={{ width: '40%' }} />
                      <div className="h-full bg-emerald-500" style={{ width: '60%' }} />
                    </div>
                    <span className="text-xs font-bold text-emerald-400">60% Bullish</span>
                  </div>
                </div>
                <TrendingUp className="w-5 h-5 text-emerald-400/50" />
              </div>
              <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Volatility Index</p>
                  <p className="text-lg font-bold text-amber-400">Medium (1.2%)</p>
                </div>
                <Zap className="w-5 h-5 text-amber-400/50" />
              </div>
              <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">24h Volume</p>
                  <p className="text-lg font-bold text-indigo-400">KES 1.2M</p>
                </div>
                <BarChart3 className="w-5 h-5 text-indigo-400/50" />
              </div>
            </div>

            {/* Arena Activity */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    <RefreshCcw className="w-5 h-5 text-emerald-400" />
                    Arena Activity
                  </h3>
                  <div className="flex bg-slate-800 p-1 rounded-lg">
                    <button 
                      onClick={() => setActivityTab("my")}
                      className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${activityTab === "my" ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      My Trades
                    </button>
                    <button 
                      onClick={() => setActivityTab("global")}
                      className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${activityTab === "global" ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      Global
                    </button>
                  </div>
                </div>
                {(activityTab === "my" ? trades.length : globalTrades.filter(t => t.status === 'open').length) > 0 && (
                  <span className="bg-emerald-500 text-slate-900 text-[10px] font-black px-2 py-0.5 rounded-full">
                    {activityTab === "my" ? trades.length : globalTrades.filter(t => t.status === 'open').length}
                  </span>
                )}
              </div>

              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {(activityTab === "my" ? trades : globalTrades).length === 0 ? (
                  <p className="text-slate-500 text-center py-8 italic text-sm">No active trades in the arena</p>
                ) : (
                  (activityTab === "my" ? trades : globalTrades).map((t, i) => (
                    <div 
                      key={t.id || i} 
                      onClick={() => setSelectedTrade(t)}
                      className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] ${
                        selectedTrade?.id === t.id ? 'ring-2 ring-emerald-500 border-emerald-500' : 'bg-slate-800/40 border-slate-700/40'
                      } ${
                        t.status === 'pending' ? 'border-amber-500/30' : ''
                      } ${
                        t.status === 'closed' ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          {t.direction === 'buy' ? (
                            <ArrowUpCircle className={`w-6 h-6 ${t.status === 'pending' ? 'text-amber-400/50' : t.status === 'closed' ? 'text-slate-500' : 'text-emerald-400'}`} />
                          ) : (
                            <ArrowDownCircle className={`w-6 h-6 ${t.status === 'pending' ? 'text-amber-400/50' : t.status === 'closed' ? 'text-slate-500' : 'text-rose-400'}`} />
                          )}
                          {t.isBot && (
                            <div className="absolute -bottom-1 -right-1 bg-amber-500 rounded-full p-0.5 border border-slate-900">
                              <Zap className="w-2 h-2 text-slate-900 fill-slate-900" />
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-bold uppercase text-xs tracking-wider">{t.direction}</p>
                            <span className="text-[8px] bg-slate-700 text-slate-300 px-1 rounded font-mono">{t.duration}</span>
                            <span className="text-[9px] text-slate-500 font-mono">#{t.userId.slice(0, 6)}</span>
                            {t.status === 'open' && t.createdAt && (
                              <span className="text-[8px] text-indigo-400 font-mono font-bold">
                                {(() => {
                                  const durationMs = t.duration === "30s" ? 30000 : t.duration === "5m" ? 300000 : 1800000;
                                  const createdAt = t.createdAt?.toMillis ? t.createdAt.toMillis() : (t.createdAt?.seconds ? t.createdAt.seconds * 1000 : Date.now());
                                  const remaining = Math.max(0, Math.floor((createdAt + durationMs - Date.now()) / 1000));
                                  return `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}`;
                                })()}
                              </span>
                            )}
                            {t.status === 'closed' && (
                              <span className="text-[8px] bg-slate-800 text-slate-500 px-1 rounded font-bold uppercase">Closed</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <p className="text-[10px] text-slate-400 font-mono">
                              {t.status === 'pending' ? 'Target' : 'Entry'}: {t.entry.toFixed(2)}
                            </p>
                            {t.isBot && <span className="text-[8px] bg-amber-500/10 text-amber-500 px-1 rounded font-bold uppercase">Bot</span>}
                            {activityTab === "global" && t.isBot && t.status !== 'closed' && (
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTradeAmount(t.amount);
                                  if (t.orderType !== 'market') setLimitPrice(t.entry);
                                  // Scroll to trade controls
                                  document.getElementById('trade-controls')?.scrollIntoView({ behavior: 'smooth' });
                                }}
                                className="text-[8px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded font-bold uppercase hover:bg-indigo-500 hover:text-white transition-all"
                              >
                                Copy
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-sm font-mono">KES {t.amount}</p>
                        {t.status === 'open' ? (
                          <div className="flex flex-col items-end">
                            <p className={`text-[10px] font-mono font-black ${
                              (t.direction === 'buy' ? currentPrice > t.entry : t.entry > currentPrice) ? 'text-emerald-400' : 'text-rose-400'
                            }`}>
                              {((t.direction === 'buy' ? currentPrice > t.entry : t.entry > currentPrice) ? '+' : '-') }
                              KES {(t.amount * 0.85).toFixed(2)}
                            </p>
                            <span className={`text-[8px] font-black px-1 rounded ${
                              (t.direction === 'buy' ? currentPrice > t.entry : t.entry > currentPrice) ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                            }`}>
                              {(t.direction === 'buy' ? currentPrice > t.entry : t.entry > currentPrice) ? 'IN THE MONEY' : 'OUT OF MONEY'}
                            </span>
                          </div>
                        ) : t.status === 'closed' && t.exitPrice ? (
                          <div className="flex flex-col items-end">
                            <p className={`text-[10px] font-mono font-bold ${
                              (t.direction === 'buy' ? t.exitPrice > t.entry : t.entry > t.exitPrice) ? 'text-emerald-400' : 'text-rose-400'
                            }`}>
                              {(t.direction === 'buy' ? t.exitPrice > t.entry : t.entry > t.exitPrice) ? '+' : '-'}
                              KES {(t.direction === 'buy' ? t.exitPrice > t.entry : t.entry > t.exitPrice) ? (t.amount * 0.85).toFixed(2) : t.amount.toFixed(2)}
                            </p>
                            <span className="text-[8px] text-slate-500 font-bold uppercase">Closed</span>
                          </div>
                        ) : t.status === 'pending' ? (
                          <p className="text-[9px] text-amber-400 font-bold uppercase animate-pulse">Pending</p>
                        ) : (
                          <p className="text-[10px] text-slate-500 font-mono">---</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Live Arena Feed */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <Globe className="w-5 h-5 text-indigo-400" />
                Live Arena Feed
              </h3>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                {arenaEvents.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 italic text-xs">Waiting for arena events...</p>
                ) : (
                  <AnimatePresence initial={false}>
                    {arenaEvents.map((event) => (
                      <motion.div 
                        key={event.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-start gap-3 p-3 bg-slate-800/30 rounded-xl border border-slate-700/30 group hover:bg-slate-800/50 transition-all"
                      >
                        <div className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                          event.type === 'success' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' :
                          event.type === 'danger' ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]' :
                          event.type === 'warning' ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]' :
                          'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] text-slate-300 leading-relaxed font-medium">
                            {event.message}
                          </p>
                          <p className="text-[9px] text-slate-500 font-mono mt-0.5">{event.time}</p>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}
              </div>
            </div>

            {/* Trade Details Summary */}
            <AnimatePresence>
              {selectedTrade && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className="bg-slate-900 p-6 rounded-2xl border border-indigo-500/30 shadow-lg shadow-indigo-500/10"
                >
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-bold flex items-center gap-2">
                      <Info className="w-5 h-5 text-indigo-400" />
                      Trade Details
                    </h3>
                    <button 
                      onClick={() => setSelectedTrade(null)}
                      className="text-slate-500 hover:text-white transition-colors"
                    >
                      <RefreshCcw className="w-4 h-4 rotate-45" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Direction</p>
                      <div className="flex items-center gap-2">
                        {selectedTrade.direction === 'buy' ? (
                          <ArrowUpCircle className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <ArrowDownCircle className="w-4 h-4 text-rose-400" />
                        )}
                        <p className="font-black uppercase text-indigo-100">{selectedTrade.direction}</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Amount</p>
                      <p className="font-black text-indigo-100 font-mono">KES {selectedTrade.amount}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Status</p>
                      <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                        selectedTrade.status === 'open' ? 'bg-emerald-500/20 text-emerald-400' : 
                        selectedTrade.status === 'pending' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {selectedTrade.status}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Entry Price</p>
                      <p className="font-black text-indigo-100 font-mono">{selectedTrade.entry.toFixed(2)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Exit Price</p>
                      <p className="font-black text-indigo-100 font-mono">
                        {selectedTrade.exitPrice ? selectedTrade.exitPrice.toFixed(2) : '---'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Profit/Loss</p>
                      <p className={`font-black font-mono ${
                        selectedTrade.exitPrice 
                          ? ((selectedTrade.direction === 'buy' ? selectedTrade.exitPrice - selectedTrade.entry : selectedTrade.entry - selectedTrade.exitPrice) >= 0 ? 'text-emerald-400' : 'text-rose-400')
                          : 'text-slate-500'
                      }`}>
                        {selectedTrade.exitPrice 
                          ? (((selectedTrade.direction === 'buy' ? selectedTrade.exitPrice - selectedTrade.entry : selectedTrade.entry - selectedTrade.exitPrice) * (selectedTrade.amount / 100)).toFixed(2))
                          : '---'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Stop Loss</p>
                      <p className="font-black text-rose-400/80 font-mono">
                        {selectedTrade.stopLoss ? `${selectedTrade.stopLoss}%` : 'None'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Take Profit</p>
                      <p className="font-black text-emerald-400/80 font-mono">
                        {selectedTrade.takeProfit ? `${selectedTrade.takeProfit}%` : 'None'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Latency</p>
                      <p className="font-black text-indigo-400 font-mono">
                        {selectedTrade.executionLatency !== undefined ? `${selectedTrade.executionLatency}ms` : '---'}
                      </p>
                    </div>
                  </div>
                  
                  {selectedTrade.closeReason && (
                    <div className="mt-6 pt-6 border-t border-slate-800">
                      <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Closure Reason</p>
                      <p className="text-sm text-indigo-200 bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
                        {selectedTrade.closeReason}
                      </p>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Performance Dashboard */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <Globe className="w-5 h-5 text-indigo-400" />
                Performance Metrics
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Total Trades</p>
                  <p className="text-2xl font-black text-white font-mono">
                    {filteredTradeHistory.length}
                  </p>
                </div>
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Win Rate</p>
                  <p className="text-2xl font-black text-emerald-400 font-mono">
                    {filteredTradeHistory.length > 0
                      ? ((filteredTradeHistory.filter(t => {
                          const profit = t.exitPrice ? (t.direction === 'buy' ? t.exitPrice - t.entry : t.entry - t.exitPrice) : 0;
                          return profit > 0;
                        }).length / filteredTradeHistory.length) * 100).toFixed(0)
                      : "0"}
                    <span className="text-sm ml-1 font-bold">%</span>
                  </p>
                </div>
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Total Profit/Loss</p>
                  <p className={`text-2xl font-black font-mono ${
                    filteredTradeHistory.reduce((acc, t) => {
                      const profitPct = t.exitPrice ? (t.direction === 'buy' ? (t.exitPrice - t.entry) / t.entry : (t.entry - t.exitPrice) / t.entry) : 0;
                      const profit = profitPct * t.amount * (t.leverage || 1);
                      return acc + profit;
                    }, 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {filteredTradeHistory.reduce((acc, t) => {
                      const profitPct = t.exitPrice ? (t.direction === 'buy' ? (t.exitPrice - t.entry) / t.entry : (t.entry - t.exitPrice) / t.entry) : 0;
                      const profit = profitPct * t.amount * (t.leverage || 1);
                      return acc + profit;
                    }, 0).toFixed(2)}
                  </p>
                </div>
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Avg Latency</p>
                  <p className="text-2xl font-black text-indigo-400 font-mono">
                    {filteredTradeHistory.filter(t => t.executionLatency !== undefined).length > 0
                      ? (filteredTradeHistory.filter(t => t.executionLatency !== undefined).reduce((acc, t) => acc + (t.executionLatency || 0), 0) / 
                         filteredTradeHistory.filter(t => t.executionLatency !== undefined).length).toFixed(0)
                      : "0"}
                    <span className="text-sm ml-1 font-bold">ms</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Trade History */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <RefreshCcw className="w-5 h-5 text-amber-400" />
                  Trade History
                </h3>
                {(filterStatus !== "all" || filterDirection !== "all" || filterStartDate || filterEndDate) && (
                  <button 
                    onClick={() => {
                      setFilterStatus("all");
                      setFilterDirection("all");
                      setFilterStartDate("");
                      setFilterEndDate("");
                    }}
                    className="text-[10px] font-bold text-rose-400 hover:text-rose-300 flex items-center gap-1 transition-colors"
                  >
                    <RefreshCcw className="w-3 h-3" />
                    CLEAR FILTERS
                  </button>
                )}
              </div>

              {/* Filters */}
              <div className="bg-slate-800/20 p-4 rounded-xl border border-slate-700/30 mb-6">
                <div className="flex items-center gap-2 mb-3 text-slate-400">
                  <Info className="w-3 h-3" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Filter Activity</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      Status
                    </label>
                    <select 
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value as any)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
                    >
                      <option value="all">All Status</option>
                      <option value="open">Open Positions</option>
                      <option value="closed">Closed Trades</option>
                      <option value="pending">Pending Orders</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" />
                      Direction
                    </label>
                    <select 
                      value={filterDirection}
                      onChange={(e) => setFilterDirection(e.target.value as any)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
                    >
                      <option value="all">All Directions</option>
                      <option value="buy">Buy / Long</option>
                      <option value="sell">Sell / Short</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Duration
                    </label>
                    <select 
                      value={filterDuration}
                      onChange={(e) => setFilterDuration(e.target.value as any)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
                    >
                      <option value="all">All Durations</option>
                      <option value="30s">30 Seconds</option>
                      <option value="5m">5 Minutes</option>
                      <option value="30m">30 Minutes</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                      <User className="w-3 h-3" />
                      From
                    </label>
                    <input 
                      type="date"
                      value={filterStartDate}
                      onChange={(e) => setFilterStartDate(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                      <Globe className="w-3 h-3" />
                      To
                    </label>
                    <input 
                      type="date"
                      value={filterEndDate}
                      onChange={(e) => setFilterEndDate(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {filteredTradeHistory.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 italic">No trades match your filters</p>
                ) : (
                  filteredTradeHistory.map((t) => {
                    const profitPct = t.exitPrice ? (t.direction === 'buy' ? (t.exitPrice - t.entry) / t.entry : (t.entry - t.exitPrice) / t.entry) : 0;
                    const profit = profitPct * t.amount * (t.leverage || 1);
                    return (
                      <div 
                        key={t.id} 
                        onClick={() => setSelectedTrade(t)}
                        className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ${
                          selectedTrade?.id === t.id ? 'ring-2 ring-indigo-500 border-indigo-500' : 'bg-slate-800/30 border-slate-700/30'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {t.direction === 'buy' ? (
                            <ArrowUpCircle className="w-5 h-5 text-emerald-400/50" />
                          ) : (
                            <ArrowDownCircle className="w-5 h-5 text-rose-400/50" />
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold uppercase text-xs">{t.direction}</p>
                              <span className="text-[8px] bg-slate-700 text-slate-300 px-1 rounded font-mono">{t.duration}</span>
                              {t.leverage && t.leverage > 1 && (
                                <span className="text-[8px] bg-indigo-500/20 text-indigo-400 px-1 rounded font-black">{t.leverage}x</span>
                              )}
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
                          {t.executionLatency !== undefined && (
                            <p className="text-[9px] text-slate-500 font-mono mt-1">
                              Lat: {t.executionLatency}ms
                            </p>
                          )}
                          {t.status === 'pending' && (
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                cancelTrade(t.id!);
                              }}
                              className="mt-2 text-[9px] font-bold text-rose-400 hover:text-rose-300 bg-rose-500/10 px-2 py-1 rounded border border-rose-500/20 transition-colors"
                            >
                              CANCEL ORDER
                            </button>
                          )}
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
            <div id="trade-controls" className="bg-slate-900 p-6 rounded-2xl border border-slate-800 space-y-4">
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
                  <label className="text-[10px] text-slate-500 uppercase font-bold">Trade Duration</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["30s", "5m", "30m"] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => setTradeDuration(d)}
                        className={`py-2 text-[10px] font-bold uppercase rounded-lg border transition-all ${
                          tradeDuration === d 
                            ? 'bg-indigo-500 border-indigo-400 text-white' 
                            : 'bg-slate-800/50 border-slate-800 text-slate-500 hover:border-slate-700'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-800">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-slate-500 uppercase font-bold">Price Alerts</label>
                    <button 
                      onClick={() => {
                        const type = alertPrice > currentPrice ? "above" : "below";
                        const alertId = generateId();
                        setPriceAlerts(prev => {
                          if (prev.some(a => a.id === alertId)) return prev;
                          return [...prev, { id: alertId, price: alertPrice, type }];
                        });
                        addToast(`Price alert set at KES ${alertPrice}`, 'info');
                      }}
                      className="text-[9px] font-bold text-indigo-400 hover:text-indigo-300 uppercase tracking-widest"
                    >
                      Set Alert
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input 
                      type="number" 
                      step="0.01"
                      value={alertPrice}
                      onChange={(e) => setAlertPrice(Number(e.target.value))}
                      className="flex-1 bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  {priceAlerts.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {priceAlerts.map(alert => (
                        <div key={alert.id} className="flex items-center gap-1.5 bg-slate-800 px-2 py-1 rounded-md border border-slate-700">
                          <span className="text-[9px] font-mono text-slate-300">{alert.price}</span>
                          <button onClick={() => setPriceAlerts(prev => prev.filter(a => a.id !== alert.id))} className="text-rose-500 hover:text-rose-400">
                            <RefreshCcw className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] text-slate-500 uppercase font-bold">Order Type</label>
                  <div className="grid grid-cols-3 gap-2">
                    {['market', 'limit', 'stop'].map((type) => (
                      <button
                        key={type}
                        onClick={() => {
                          setOrderType(type as any);
                          if (type !== 'market') {
                            setTargetPrice(currentPrice);
                          }
                        }}
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

              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      Leverage
                    </label>
                    <span className="text-[10px] font-black text-indigo-400">{leverage}x</span>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {[1, 10, 20, 50, 100].map((l) => (
                      <button
                        key={l}
                        onClick={() => setLeverage(l)}
                        className={`py-2 text-[10px] font-bold rounded-lg border transition-all ${
                          leverage === l 
                            ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg shadow-indigo-500/20' 
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        {l}x
                      </button>
                    ))}
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
              </div>

              {/* AI Bot Toggle & Settings */}
              <div className="pt-4 border-t border-slate-800">
                <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${isAiBotEnabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                        <RefreshCcw className={`w-4 h-4 ${isAiBotEnabled ? 'animate-spin' : ''}`} />
                      </div>
                      <div>
                        <p className="text-sm font-bold">AI Trading Bot</p>
                        <p className="text-[10px] text-slate-500">Autonomous pattern-based trading</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setIsAiBotEnabled(!isAiBotEnabled)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${isAiBotEnabled ? 'bg-emerald-500' : 'bg-slate-700'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isAiBotEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  <AnimatePresence>
                    {isAiBotEnabled && (
                      <motion.div 
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="border-t border-slate-700/50 bg-slate-900/50"
                      >
                        <div className="p-4 space-y-4">
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-[10px] text-slate-500 uppercase font-bold">Trade Amount</label>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">KES</span>
                                <input 
                                  type="number"
                                  value={aiBotAmount}
                                  onChange={(e) => setAiBotAmount(Number(e.target.value))}
                                  className="w-full bg-slate-800 border border-slate-700 rounded-lg py-1.5 pl-9 pr-3 text-xs font-bold focus:outline-none focus:border-emerald-500"
                                />
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[10px] text-slate-500 uppercase font-bold">Order Type</label>
                              <select 
                                value={aiBotOrderType}
                                onChange={(e) => setAiBotOrderType(e.target.value as any)}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-xs font-bold focus:outline-none focus:border-emerald-500"
                              >
                                <option value="market">Market</option>
                                <option value="limit">Limit</option>
                                <option value="stop">Stop</option>
                              </select>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-[10px] text-slate-500 uppercase font-bold">Stop Loss (%)</label>
                              <input 
                                type="number"
                                value={aiBotStopLoss}
                                onChange={(e) => setAiBotStopLoss(Number(e.target.value))}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-xs font-bold focus:outline-none focus:border-rose-500"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[10px] text-slate-500 uppercase font-bold">Take Profit (%)</label>
                              <input 
                                type="number"
                                value={aiBotTakeProfit}
                                onChange={(e) => setAiBotTakeProfit(Number(e.target.value))}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-xs font-bold focus:outline-none focus:border-emerald-500"
                              />
                            </div>
                          </div>

                          <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3">
                            <div className="flex items-start gap-2">
                              <Info className="w-3 h-3 text-emerald-400 mt-0.5" />
                              <p className="text-[9px] text-slate-400 leading-relaxed">
                                The AI bot will scan market patterns every 15 seconds and place trades using these parameters. It will automatically stop if your balance falls below the trade amount.
                              </p>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* AI Market Insights */}
              <div className="pt-4 border-t border-slate-800">
                <div className="bg-slate-800/30 rounded-xl border border-slate-700/50 overflow-hidden">
                  <div className="p-4 flex items-center justify-between border-b border-slate-700/50">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-purple-500/20 rounded-lg text-purple-400">
                        <RefreshCcw className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
                      </div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">AI Market Insights</h4>
                    </div>
                    <button 
                      onClick={getAiAnalysis}
                      disabled={isAnalyzing}
                      className="text-[10px] font-bold text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-50"
                    >
                      {isAnalyzing ? 'ANALYZING...' : 'REFRESH'}
                    </button>
                  </div>
                  
                  <div className="p-4 space-y-4">
                    {!aiAnalysis ? (
                      <div className="text-center py-4">
                        <p className="text-[10px] text-slate-500 italic">Click refresh for real-time AI market analysis</p>
                      </div>
                    ) : (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 uppercase font-bold">Sentiment</span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              aiAnalysis.sentiment === 'Bullish' ? 'bg-emerald-500/20 text-emerald-400' :
                              aiAnalysis.sentiment === 'Bearish' ? 'bg-rose-500/20 text-rose-400' :
                              'bg-slate-700 text-slate-400'
                            }`}>
                              {aiAnalysis.sentiment}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 uppercase font-bold">Action</span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              aiAnalysis.recommendation.toLowerCase().includes('buy') ? 'bg-emerald-500/20 text-emerald-400' :
                              aiAnalysis.recommendation.toLowerCase().includes('sell') ? 'bg-rose-500/20 text-rose-400' :
                              'bg-slate-700 text-slate-400'
                            }`}>
                              {aiAnalysis.recommendation}
                            </span>
                          </div>
                        </div>
                        
                        <div className="space-y-1">
                          <p className="text-[10px] text-slate-500 uppercase font-bold">Prediction</p>
                          <p className="text-xs text-slate-200 font-medium leading-relaxed">{aiAnalysis.prediction}</p>
                        </div>
                        
                        <div className="space-y-1">
                          <p className="text-[10px] text-slate-500 uppercase font-bold">Reasoning</p>
                          <p className="text-[10px] text-slate-400 leading-relaxed italic">"{aiAnalysis.reasoning}"</p>
                        </div>
                      </motion.div>
                    )}
                  </div>
                </div>
              </div>

            {/* Leaderboard */}
            <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <Trophy className="w-5 h-5 text-amber-400" />
                  Leaderboard
                </h3>
                <div className="flex items-center gap-1.5 bg-amber-500/10 px-2 py-1 rounded-full">
                  <div className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
                  <span className="text-[9px] font-bold text-amber-400 uppercase tracking-widest">Rotating Leader</span>
                </div>
              </div>

              {/* Leader Spotlight */}
              {leaderboard.length > 0 && (
                <AnimatePresence mode="wait">
                  <motion.div 
                    key={leaderboard[activeLeaderIndex]?.userId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mb-6 p-4 bg-gradient-to-br from-amber-500/10 to-transparent border border-amber-500/20 rounded-xl relative overflow-hidden"
                  >
                    <div className="absolute top-0 right-0 p-2">
                      <Trophy className="w-8 h-8 text-amber-500/10" />
                    </div>
                    <p className="text-[10px] text-amber-500/60 font-bold uppercase tracking-widest mb-1">Active Leader Spotlight</p>
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 font-bold border border-amber-500/30">
                          #{activeLeaderIndex + 1}
                        </div>
                        <motion.div 
                          className="absolute -inset-1 border border-amber-500/30 rounded-full"
                          animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0, 0.3] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-white">
                            {leaderboard[activeLeaderIndex]?.name || leaderboard[activeLeaderIndex]?.userId.slice(0, 8)}
                          </p>
                          {leaderboard[activeLeaderIndex]?.userId.startsWith('sim_bot') && (
                            <Zap className="w-3 h-3 text-amber-400 fill-amber-400/20" />
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 font-mono">
                          KES {leaderboard[activeLeaderIndex]?.balance.toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              )}

              <div className="space-y-4">
                {leaderboard.map((player, i) => (
                  <div 
                    key={player.userId || `player-${i}`} 
                    className={`flex items-center justify-between p-2 rounded-lg transition-all ${
                      i === activeLeaderIndex ? 'bg-amber-500/5 border border-amber-500/10' : ''
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold w-5 ${i === 0 ? 'text-amber-400' : 'text-slate-500'}`}>
                        {i + 1}
                      </span>
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-medium truncate max-w-[100px] ${i === activeLeaderIndex ? 'text-amber-400' : 'text-slate-200'}`}>
                          {player.name || player.userId.slice(0, 8)}
                        </p>
                        {player.userId.startsWith('sim_bot') && (
                          <Zap className="w-3 h-3 text-amber-400/50" />
                        )}
                      </div>
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
    </div>

      {/* Floating AI Analysis Button */}
      <div className="fixed bottom-8 right-8 z-[100]">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={getAiAnalysis}
          disabled={isAnalyzing}
          className={`group flex items-center gap-3 px-6 py-4 rounded-2xl font-bold shadow-2xl transition-all border ${
            isAnalyzing 
              ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed' 
              : 'bg-gradient-to-r from-purple-600 to-indigo-600 border-purple-500/30 text-white hover:shadow-purple-500/20'
          }`}
        >
          <div className="relative">
            <Brain className={`w-6 h-6 ${isAnalyzing ? 'animate-pulse' : 'group-hover:rotate-12 transition-transform'}`} />
            {isAnalyzing && (
              <motion.div 
                className="absolute inset-0 border-2 border-white rounded-full"
                animate={{ scale: [1, 1.5], opacity: [1, 0] }}
                transition={{ duration: 1, repeat: Infinity }}
              />
            )}
          </div>
          <div className="text-left">
            <p className="text-[10px] uppercase tracking-widest opacity-70 leading-none mb-1">Gemini AI</p>
            <p className="text-sm leading-none">{isAnalyzing ? 'Analyzing Market...' : 'Deep Market Scan'}</p>
          </div>
        </motion.button>
      </div>

      {/* Trade Confirmation Modal */}
      <AnimatePresence>
        {showConfirmModal && pendingTrade && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-slate-900 border border-slate-800 rounded-3xl p-8 max-w-sm w-full shadow-2xl relative overflow-hidden"
            >
              <div className={`absolute top-0 left-0 w-full h-1 ${pendingTrade.direction === 'buy' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
              
              <div className="text-center mb-8">
                <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${
                  pendingTrade.direction === 'buy' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                }`}>
                  {pendingTrade.direction === 'buy' ? <ArrowUpCircle className="w-10 h-10" /> : <ArrowDownCircle className="w-10 h-10" />}
                </div>
                <h2 className="text-2xl font-bold text-white">Confirm {pendingTrade.direction.toUpperCase()}</h2>
                <p className="text-slate-400 text-sm mt-1">Review your trade parameters</p>
              </div>

              <div className="space-y-4 mb-8">
                <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
                  <span className="text-slate-400 text-xs font-bold uppercase tracking-wider">Amount</span>
                  <span className="text-white font-mono font-bold">KES {pendingTrade.amount.toLocaleString()}</span>
                </div>
                
                <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
                  <span className="text-slate-400 text-xs font-bold uppercase tracking-wider">Duration</span>
                  <span className="text-white font-mono font-bold">{pendingTrade.duration}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-4 bg-rose-500/5 rounded-2xl border border-rose-500/10">
                    <p className="text-[10px] text-rose-500/60 font-bold uppercase tracking-wider mb-1">Stop Loss</p>
                    <p className="text-rose-400 font-mono font-bold">-{pendingTrade.stopLoss}%</p>
                  </div>
                  <div className="p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
                    <p className="text-[10px] text-emerald-500/60 font-bold uppercase tracking-wider mb-1">Take Profit</p>
                    <p className="text-emerald-400 font-mono font-bold">+{pendingTrade.takeProfit}%</p>
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-2xl border border-slate-700/50">
                  <span className="text-slate-400 text-xs font-bold uppercase tracking-wider">Type</span>
                  <span className="text-white text-xs font-bold uppercase tracking-widest">{pendingTrade.orderType}</span>
                </div>

                {pendingTrade.orderType !== 'market' && (
                  <div className="flex items-center justify-between p-4 bg-amber-500/5 rounded-2xl border border-amber-500/10">
                    <span className="text-amber-500/60 text-xs font-bold uppercase tracking-wider">Target</span>
                    <span className="text-amber-400 font-mono font-bold">{pendingTrade.targetPrice.toFixed(2)}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <button 
                  onClick={handleConfirmTrade}
                  disabled={isExecuting}
                  className={`w-full py-4 rounded-2xl font-bold text-slate-900 transition-all shadow-lg flex items-center justify-center gap-2 ${
                    isExecuting ? 'bg-slate-700 cursor-not-allowed' :
                    pendingTrade.direction === 'buy' 
                      ? 'bg-emerald-500 hover:bg-emerald-400 shadow-emerald-500/20' 
                      : 'bg-rose-500 hover:bg-rose-400 shadow-rose-500/20'
                  }`}
                >
                  {isExecuting ? (
                    <>
                      <RefreshCcw className="w-5 h-5 animate-spin" />
                      EXECUTING IN {executionCountdown}...
                    </>
                  ) : (
                    "EXECUTE TRADE"
                  )}
                </button>
                <button 
                  onClick={() => !isExecuting && setShowConfirmModal(false)}
                  disabled={isExecuting}
                  className={`w-full py-4 rounded-2xl font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition-all ${isExecuting ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  CANCEL
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

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

                <div className="space-y-2">
                  <label className="text-xs text-slate-400 uppercase font-bold">M-Pesa Phone Number</label>
                  <input 
                    type="text" 
                    placeholder="2547XXXXXXXX"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-lg font-mono focus:outline-none focus:border-emerald-500 transition-colors"
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
      {/* Withdrawal Modal */}
      <AnimatePresence>
        {showWithdrawModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <TrendingDown className="w-5 h-5 text-rose-400" />
                  Withdraw Funds
                </h2>
                <button 
                  onClick={() => setShowWithdrawModal(false)}
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
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(Number(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-2xl font-bold focus:outline-none focus:border-rose-500 transition-colors"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-slate-400 uppercase font-bold">M-Pesa Phone Number</label>
                  <input 
                    type="text" 
                    placeholder="2547XXXXXXXX"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-lg font-mono focus:outline-none focus:border-rose-500 transition-colors"
                  />
                </div>

                <button 
                  onClick={handleWithdraw}
                  disabled={isWithdrawing}
                  className="w-full bg-rose-500 hover:bg-rose-600 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-rose-500/20 flex items-center justify-center gap-2"
                >
                  {isWithdrawing ? (
                    <RefreshCcw className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <TrendingDown className="w-5 h-5" />
                      WITHDRAW TO M-PESA
                    </>
                  )}
                </button>
                
                <p className="text-[10px] text-slate-500 text-center italic">
                  Withdrawals are processed instantly to your registered M-Pesa number.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Profile Modal */}
      <AnimatePresence>
        {showProfileModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <User className="w-5 h-5 text-amber-400" />
                  Profile Settings
                </h2>
                <button 
                  onClick={() => setShowProfileModal(false)}
                  className="text-slate-500 hover:text-white p-2"
                >
                  ✕
                </button>
              </div>
              
              <div className="space-y-6">
                <div className="flex justify-center mb-4">
                  <div className="relative group">
                    <img 
                      src={photoUrl || `https://picsum.photos/seed/${user?.uid}/200`} 
                      alt="Profile" 
                      className="w-24 h-24 rounded-full border-4 border-slate-800 object-cover shadow-xl"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Camera className="w-6 h-6 text-white" />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-slate-400 uppercase font-bold">Display Name</label>
                  <input 
                    type="text" 
                    placeholder="Enter your trading name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-lg font-bold focus:outline-none focus:border-amber-500 transition-colors"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-slate-400 uppercase font-bold">Profile Picture URL</label>
                  <input 
                    type="text" 
                    placeholder="https://example.com/photo.jpg"
                    value={photoUrl}
                    onChange={(e) => setPhotoUrl(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-xs font-mono focus:outline-none focus:border-amber-500 transition-colors"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-slate-400 uppercase font-bold">Short Bio</label>
                  <textarea 
                    placeholder="Tell the arena about your strategy..."
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-sm focus:outline-none focus:border-amber-500 transition-colors h-24 resize-none"
                  />
                </div>

                <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                  <div>
                    <p className="text-xs font-bold text-white">One-Click Trading</p>
                    <p className="text-[10px] text-slate-500">Skip confirmation for faster execution</p>
                  </div>
                  <button 
                    onClick={() => setOneClickTrading(!oneClickTrading)}
                    className={`w-12 h-6 rounded-full transition-all relative ${oneClickTrading ? 'bg-emerald-500' : 'bg-slate-700'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${oneClickTrading ? 'left-7' : 'left-1'}`} />
                  </button>
                </div>

                <div className="p-4 bg-indigo-500/5 rounded-xl border border-indigo-500/10 space-y-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="w-4 h-4 text-indigo-400" />
                    <p className="text-xs font-bold text-white uppercase tracking-wider">AI Bot Preferences</p>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Bot Amount</label>
                      <input 
                        type="number"
                        value={aiBotAmount}
                        onChange={(e) => setAiBotAmount(Number(e.target.value))}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Order Type</label>
                      <select 
                        value={aiBotOrderType}
                        onChange={(e) => setAiBotOrderType(e.target.value as any)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500"
                      >
                        <option value="market">Market</option>
                        <option value="limit">Limit</option>
                        <option value="stop">Stop</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Stop Loss %</label>
                      <input 
                        type="number"
                        value={aiBotStopLoss}
                        onChange={(e) => setAiBotStopLoss(Number(e.target.value))}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Take Profit %</label>
                      <input 
                        type="number"
                        value={aiBotTakeProfit}
                        onChange={(e) => setAiBotTakeProfit(Number(e.target.value))}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-bold focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                <button 
                  onClick={updateProfile}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-4 rounded-xl transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2"
                >
                  <RefreshCcw className="w-5 h-5" />
                  UPDATE PROFILE
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Premium Modal */}
      <AnimatePresence>
        {showPremiumModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-slate-900 border border-indigo-500/30 rounded-3xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-4">
                <button onClick={() => setShowPremiumModal(false)} className="text-slate-500 hover:text-white">✕</button>
              </div>

              <div className="text-center space-y-4">
                <div className="inline-flex p-4 bg-indigo-500/10 rounded-2xl mb-2">
                  <Trophy className="w-12 h-12 text-indigo-400" />
                </div>
                <h2 className="text-3xl font-black text-white tracking-tighter">Upgrade to PREMIUM</h2>
                <p className="text-slate-400 text-sm">Unlock the full power of the mosinhioTrade Arena.</p>
              </div>

              <div className="mt-8 space-y-4">
                {[
                  { icon: <Brain className="w-5 h-5" />, text: "Unlimited Gemini AI Deep Market Scans" },
                  { icon: <Zap className="w-5 h-5" />, text: "Full Access to AI Trading Bot" },
                  { icon: <TrendingUp className="w-5 h-5" />, text: "Priority Execution & Advanced Patterns" },
                  { icon: <Globe className="w-5 h-5" />, text: "Exclusive Premium Badge on Leaderboard" }
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-slate-200 bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
                    <div className="text-indigo-400">{item.icon}</div>
                    <span className="text-xs font-bold">{item.text}</span>
                  </div>
                ))}
              </div>

              <div className="mt-8 space-y-4">
                <div className="flex items-center justify-between p-4 bg-indigo-500/20 rounded-2xl border border-indigo-500/30">
                  <div>
                    <p className="text-[10px] text-indigo-300 uppercase font-black">Lifetime Access</p>
                    <p className="text-2xl font-black text-white">KES 5,000</p>
                  </div>
                  <span className="text-[10px] bg-indigo-500 text-white px-2 py-1 rounded-full font-bold">BEST VALUE</span>
                </div>

                <button 
                  onClick={upgradeToPremium}
                  className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white font-black py-4 rounded-2xl transition-all shadow-xl shadow-indigo-500/20 flex items-center justify-center gap-2"
                >
                  UPGRADE NOW
                </button>
                <p className="text-[10px] text-slate-500 text-center italic">Payment will be deducted from your Demo balance.</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Toast Notifications */}
      <div className="fixed bottom-6 right-6 z-[200] space-y-3 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.9 }}
              className={`p-4 rounded-xl border shadow-2xl flex items-center gap-3 pointer-events-auto min-w-[280px] ${
                toast.type === 'success' ? 'bg-emerald-900/90 border-emerald-500/50 text-emerald-100' :
                toast.type === 'error' ? 'bg-rose-900/90 border-rose-500/50 text-rose-100' :
                'bg-slate-900/90 border-slate-700/50 text-slate-100'
              }`}
            >
              {toast.type === 'success' && <Trophy className="w-5 h-5 text-emerald-400" />}
              {toast.type === 'error' && <Info className="w-5 h-5 text-rose-400" />}
              {toast.type === 'info' && <RefreshCcw className="w-5 h-5 text-indigo-400" />}
              <p className="text-sm font-bold">{toast.message}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
