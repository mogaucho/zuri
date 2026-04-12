import express from "express";
import { Server } from "socket.io";
import http from "http";
import path from "path";
import cors from "cors";
import fs from "fs";
import admin from "firebase-admin";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, where, orderBy, limit, serverTimestamp, runTransaction, onSnapshot } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

// --- Firebase Initialization ---
let db: Firestore | null = null;
let adminDb: admin.firestore.Firestore | null = null;

async function initFirebase() {
  if (!db || !adminDb) {
    try {
      const configPath = "./firebase-applet-config.json";
      if (!fs.existsSync(configPath)) {
        console.warn("Firebase config file missing. Firebase features will be disabled.");
        return null;
      }
      
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      
      // Client SDK (for real-time listeners)
      const app = initializeApp(firebaseConfig);
      db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
      
      // Admin SDK (for reliable writes/reads)
      if (!admin.apps.length) {
        admin.initializeApp({
          projectId: firebaseConfig.projectId,
        });
      }
      
      const databaseId = firebaseConfig.firestoreDatabaseId || "(default)";
      console.log(`Initializing Admin SDK for Project: ${firebaseConfig.projectId}, Database: ${databaseId}`);
      
      if (databaseId && databaseId !== "(default)") {
        adminDb = admin.firestore(databaseId);
      } else {
        adminDb = admin.firestore();
      }

      // Test connection
      try {
        await adminDb.collection("users").limit(1).get();
        console.log("Admin SDK connection test successful.");
      } catch (testError) {
        console.error("Admin SDK connection test failed:", testError);
        if (databaseId !== "(default)") {
          console.log("Attempting fallback to (default) database...");
          adminDb = admin.firestore();
          db = getFirestore(app); // Fallback client SDK too
          try {
            await adminDb.collection("users").limit(1).get();
            console.log("Fallback to (default) database successful.");
          } catch (fallbackError) {
            console.error("Fallback to (default) database also failed:", fallbackError);
          }
        }
      }
      
      console.log(`Firebase SDKs initialized successfully.`);
    } catch (error) {
      console.error("Failed to initialize Firebase:", error);
      return null;
    }
  }
  return { db, adminDb };
}

function getFirebase() {
  if (!db || !adminDb) {
    return null;
  }
  return { db, adminDb };
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
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw here to avoid crashing the server, but we log it clearly
}

async function startServer() {
  console.log("Starting server initialization...");
  
  // Initialize Firebase first
  await initFirebase();
  
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  console.log("Setting up server and socket.io...");
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" },
  });

  // --- Helper Functions for Real-time Updates ---
  let tradesCache: any[] = [];
  let leaderboardCache: any[] = [];
  const userSockets = new Map<string, string>();

  const emitUserTrades = (userId: string) => {
    const userTrades = tradesCache.filter(t => t.userId === userId);
    const active = userTrades.filter(t => ["open", "pending"].includes(t.status));
    const history = userTrades
      .filter(t => t.status === "closed")
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, 10);
    io.to(userId).emit("userTradesUpdate", { activeTrades: active, tradeHistory: history });
  };

  const emitGlobalTrades = () => {
    const globalTrades = tradesCache
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, 30);
    io.emit("globalTradesUpdate", globalTrades);
  };

  const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const emitArenaEvent = (message: string, type: 'info' | 'success' | 'danger' | 'warning' = 'info') => {
    io.emit("arenaEvent", {
      id: generateId(),
      message,
      type,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
  };

  // Initialize Listeners
  const { adminDb: initialAdminDb } = getFirebase() || {};
  if (initialAdminDb) {
    // Listen to Active Trades
    initialAdminDb.collection("trades")
      .where("status", "in", ["open", "pending"])
      .onSnapshot(
        (snapshot) => {
          const activeTrades = snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
          const activeIds = new Set(activeTrades.map(t => t.id));
          
          // Merge active trades into cache, keeping existing closed trades that aren't in the active set
          const closedTrades = tradesCache.filter(t => t.status === "closed" && !activeIds.has(t.id));
          tradesCache = [...activeTrades, ...closedTrades];
          
          // Notify affected users
          const affectedUsers = new Set(activeTrades.map(t => t.userId));
          affectedUsers.forEach(uid => emitUserTrades(uid));
        },
        (error) => handleFirestoreError(error, OperationType.LIST, "trades (active)")
      );

    // Listen to Recent Trades (for Global Marquee and History)
    initialAdminDb.collection("trades")
      .orderBy("createdAt", "desc")
      .limit(50)
      .onSnapshot(
        (snapshot) => {
          const recentTrades = snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
          const recentIds = new Set(recentTrades.map(t => t.id));

          // Merge recent trades into cache
          tradesCache = [
            ...recentTrades,
            ...tradesCache.filter(t => !recentIds.has(t.id))
          ];

          // Global update
          emitGlobalTrades();

          // Also update user history for users who might have had a trade close
          const affectedUsers = new Set(recentTrades.map(t => t.userId));
          affectedUsers.forEach(uid => emitUserTrades(uid));
        },
        (error) => handleFirestoreError(error, OperationType.LIST, "trades (recent)")
      );

    // Listen to Leaderboard
    initialAdminDb.collection("users")
      .orderBy("balance", "desc")
      .limit(10)
      .onSnapshot(
        (snapshot) => {
          leaderboardCache = snapshot.docs.map(doc => {
            const data = doc.data();
            return { 
              userId: data.userId, 
              balance: data.balance,
              name: data.name || data.userId.split("_").pop()
            };
          });
          io.emit("leaderboardUpdate", leaderboardCache);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, "users (leaderboard)")
      );
  }

  // --- Trading Bots Simulation ---
  const BOTS = [
    { id: "bot_alpha", name: "AlphaBot AI", balance: 150000 },
    { id: "bot_quant", name: "QuantMaster", balance: 280000 },
    { id: "bot_nexus", name: "NexusTrade", balance: 95000 },
    { id: "bot_zenith", name: "ZenithAlgo", balance: 420000 },
    { id: "bot_vortex", name: "VortexScalper", balance: 185000 }
  ];

  const initBots = async () => {
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return;
    for (const bot of BOTS) {
      try {
        const botRef = adminDb.collection("users").doc(bot.id);
        const botDoc = await botRef.get();
        if (!botDoc.exists) {
          await botRef.set({
            userId: bot.id,
            name: bot.name,
            balance: bot.balance,
            role: "bot",
            isDemo: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${bot.id} (init)`);
      }
    }
  };
  initBots();

  setInterval(async () => {
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return;

    try {
      // Pick a random bot to trade
      const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
      const direction = Math.random() > 0.5 ? "buy" : "sell";
      const amount = 500 + Math.floor(Math.random() * 2000);
      
      // Place a trade for the bot
      await adminDb.collection("trades").add({
        userId: bot.id,
        direction,
        amount,
        entry: price,
        status: "open",
        roundId,
        orderType: "market",
        pattern: "Bot Strategy",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        stopLoss: 5,
        takeProfit: 10
      });

      // Occasionally update bot balance to simulate wins/losses
      const botRef = adminDb.collection("users").doc(bot.id);
      const botDoc = await botRef.get();
      if (botDoc.exists) {
        const currentBalance = botDoc.data()?.balance || 0;
        const change = (Math.random() - 0.4) * 500; // Slightly biased towards profit
        await botRef.update({ balance: currentBalance + change });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, "botTradeInterval");
    }
  }, 12000); // Bot trades every 12 seconds

  // --- Price Engine ---
  let price = 100.0;
  let roundId = 1;
  let nextSettlementAt = Date.now() + 10000;
  setInterval(async () => {
    price += (Math.random() - 0.5) * 0.5;
    price = parseFloat(price.toFixed(2));
    io.emit("priceUpdate", { price, roundId, nextSettlementAt });

    const { db } = getFirebase() || {};
    if (!db) return;

    // 1. Check Pending Orders (Using Cache)
    const pendingTrades = tradesCache.filter(t => t.status === "pending");
    for (const t of pendingTrades) {
      const target = t.targetPrice;
      let shouldExecute = false;

      if (t.orderType === "limit") {
        if (t.direction === "buy" && price <= target) shouldExecute = true;
        if (t.direction === "sell" && price >= target) shouldExecute = true;
      } else if (t.orderType === "stop") {
        if (t.direction === "buy" && price >= target) shouldExecute = true;
        if (t.direction === "sell" && price <= target) shouldExecute = true;
      }

      if (shouldExecute) {
        try {
          const { adminDb } = getFirebase() || {};
          if (!adminDb) continue;
          await adminDb.collection("trades").doc(t.id).update({ 
            status: "open", 
            entry: price,
            roundId: roundId,
            executedAt: admin.firestore.FieldValue.serverTimestamp() 
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `trades/${t.id}`);
        }
      }
    }

    // 2. Check for Stop Loss / Take Profit hits (Using Cache)
    const openTrades = tradesCache.filter(t => t.status === "open");
    for (const trade of openTrades) {
      const { direction, entry, stopLoss, takeProfit, userId, amount, id } = trade;
      
      let profitPct = direction === "buy" ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
      let shouldClose = false;
      let reason = "";

      if (stopLoss && profitPct <= -Math.abs(stopLoss)) {
        shouldClose = true;
        reason = "Stop Loss Hit";
      } else if (takeProfit && profitPct >= Math.abs(takeProfit)) {
        shouldClose = true;
        reason = "Take Profit Hit";
      }

      if (shouldClose) {
        try {
          const { adminDb } = getFirebase() || {};
          if (!adminDb) continue;
          const userRef = adminDb.collection("users").doc(userId);
          const userSnap = await userRef.get();
          if (userSnap.exists) {
            const userData = userSnap.data();
            const profit = (profitPct / 100) * amount * (trade.leverage || 1);
            const newBalance = (userData?.balance || 0) + amount + profit;
            
            await userRef.update({ balance: newBalance });
            await adminDb.collection("trades").doc(id).update({ 
              status: "closed", 
              exitPrice: price, 
              closeReason: reason 
            });
            
            emitArenaEvent(`${userId.slice(0, 8)} hit ${reason} with KES ${profit.toFixed(0)} profit`, profit >= 0 ? 'success' : 'danger');

            const socketId = userSockets.get(userId);
            if (socketId) {
              io.to(socketId).emit("tradeClosed", { profit, balance: newBalance, reason });
            }
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `trades/${id} (SL/TP)`);
        }
      }
    }

    // 3. Check for Duration Expiry
    for (const trade of openTrades) {
      const { duration, createdAt, id, userId, direction, entry, amount } = trade;
      if (!createdAt || !duration) continue;

      const createdMs = createdAt.seconds * 1000;
      const nowMs = Date.now();
      let durationMs = 30000; // 30s default
      if (duration === "5m") durationMs = 5 * 60 * 1000;
      if (duration === "30m") durationMs = 30 * 60 * 1000;

      if (nowMs - createdMs >= durationMs) {
        try {
          const { adminDb } = getFirebase() || {};
          if (!adminDb) continue;

          const userRef = adminDb.collection("users").doc(userId);
          const userSnap = await userRef.get();
          if (userSnap.exists) {
            const userData = userSnap.data();
            const result = await adminDb.runTransaction(async (transaction) => {
              const uSnap = await transaction.get(userRef);
              if (!uSnap.exists) throw new Error("User not found");
              
              const userData = uSnap.data();
              const currentBalance = userData?.balance || 0;
              const profitPct = direction === "buy" ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
              const profit = (profitPct / 100) * amount * (trade.leverage || 1);
              const newBalance = currentBalance + amount + profit;
              
              transaction.update(userRef, { balance: newBalance });
              transaction.update(adminDb.collection("trades").doc(id), { 
                status: "closed", 
                exitPrice: price, 
                closeReason: `Duration Expired (${duration})`,
                closedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              
              return { newBalance, profit };
            });
            
            const socketId = userSockets.get(userId);
            io.to(userId).emit("tradeClosed", { 
              profit: result.profit, 
              balance: result.newBalance, 
              reason: `Duration Expired (${duration})` 
            });
            io.to(userId).emit("balanceUpdate", result.newBalance);
            emitArenaEvent(`${userId.slice(0, 8)} settled trade with KES ${result.profit.toFixed(0)} profit`, result.profit >= 0 ? 'success' : 'danger');
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `trades/${id} (Duration)`);
        }
      }
    }
  }, 2000); // Slowed down to 2s to save quota

  const SPREAD_PERCENT = 0.05; // 0.05% spread
const COMMISSION_PERCENT = 0.1; // 0.1% commission fee

// --- Socket Logic ---
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("register", async (userId) => {
      const { adminDb } = getFirebase() || {};
      if (!adminDb) return;
      socket.join(userId);
      try {
        userSockets.set(userId, socket.id);
        const userRef = adminDb.collection("users").doc(userId);
        const userSnap = await userRef.get();
        
        if (!userSnap.exists) {
          const initialBalance = 10000;
          const initialData = {
            userId,
            balance: initialBalance,
            socketId: socket.id,
            role: "user",
            isPremium: false,
            oneClickTrading: false,
            bio: "New trader in the arena",
            photoUrl: `https://picsum.photos/seed/${userId}/200`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          };
          await userRef.set(initialData);
          io.to(userId).emit("balanceUpdate", initialBalance);
          socket.emit("profileUpdate", initialData);
        } else {
          const userData = userSnap.data() as any;
          await userRef.update({ socketId: socket.id });
          io.to(userId).emit("balanceUpdate", userData?.balance);
          socket.emit("profileUpdate", userData);
        }
        socket.emit("priceUpdate", { price, roundId });
        
        // Initial trades update from cache
        const userTrades = tradesCache.filter(t => t.userId === userId);
        const active = userTrades.filter(t => ["open", "pending"].includes(t.status));
        const history = userTrades
          .filter(t => t.status === "closed")
          .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
          .slice(0, 10);
        socket.emit("userTradesUpdate", { activeTrades: active, tradeHistory: history });
        
        const globalTrades = tradesCache
          .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
          .slice(0, 20);
        socket.emit("globalTradesUpdate", globalTrades);
        socket.emit("leaderboardUpdate", leaderboardCache);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${userId} (register)`);
        console.error("Error registering user:", error);
      }
    });

    socket.on("openTrade", async (data) => {
      const { adminDb } = getFirebase() || {};
      if (!adminDb) return;
      
      console.log(`[Trade Request] User: ${data.userId}, Direction: ${data.direction}, Amount: ${data.amount}, Type: ${data.orderType}`);

      try {
        if (!data.amount || data.amount <= 0) {
          throw new Error("Invalid trade amount");
        }

        const userRef = adminDb.collection("users").doc(data.userId);
        
        const result = await adminDb.runTransaction(async (transaction) => {
          const userSnap = await transaction.get(userRef);
          if (!userSnap.exists) throw new Error("User not found");
          
          const userData = userSnap.data();
          const currentBalance = userData?.balance || 0;
          
          const leverage = data.leverage || 1;
          const commission = (data.amount * leverage) * (COMMISSION_PERCENT / 100);
          
          if (data.amount + commission > currentBalance) {
            throw new Error("Insufficient balance for margin and commission");
          }
          
          const newBalance = currentBalance - data.amount - commission;
          transaction.update(userRef, { balance: newBalance });
          
          const isMarket = !data.orderType || data.orderType === "market";
          const status = isMarket ? "open" : "pending";
          
          // Apply Spread and Slippage
          const slippage = (Math.random() * 0.02) / 100; // 0% - 0.02% random slippage
          const spread = (price * (SPREAD_PERCENT / 100));
          
          let entry = isMarket ? price : data.targetPrice;
          if (isMarket) {
            entry = data.direction === "buy" ? price + spread + (price * slippage) : price - spread - (price * slippage);
          }
          
          const executionLatency = data.confirmedAt ? Date.now() - data.confirmedAt : null;
          
          const tradeRef = adminDb.collection("trades").doc();
          transaction.set(tradeRef, {
            userId: data.userId,
            direction: data.direction,
            amount: data.amount,
            leverage: leverage,
            commission: commission,
            entry: entry,
            status: status,
            roundId,
            stopLoss: data.stopLoss || null,
            takeProfit: data.takeProfit || null,
            pattern: data.pattern || "None",
            orderType: data.orderType || "market",
            targetPrice: data.targetPrice || null,
            duration: data.duration || "30s",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            executionLatency: executionLatency
          });
          
          return { newBalance, tradeId: tradeRef.id, status };
        });

        socket.emit("balanceUpdate", result.newBalance);
        io.to(data.userId).emit("balanceUpdate", result.newBalance);
        
        // Immediate feedback for the user
        socket.emit("tradeOpened", { 
          tradeId: result.tradeId, 
          status: result.status,
          message: result.status === "open" ? "Trade executed successfully" : "Pending order placed"
        });

        console.log(`[Trade Success] User: ${data.userId}, Status: ${result.status}, New Balance: ${result.newBalance}`);
      } catch (error: any) {
        console.error(`[Trade Error] User: ${data.userId}, Error: ${error.message}`);
        if (error.message === "Insufficient balance" || error.message === "Invalid trade amount") {
          socket.emit("errorMsg", error.message);
        } else {
          handleFirestoreError(error, OperationType.CREATE, `trades (user: ${data.userId})`);
        }
      }
    });

    socket.on("cancelTrade", async (data: { tradeId: string, userId: string }) => {
      const { adminDb } = getFirebase() || {};
      if (!adminDb) return;
      try {
        const tradeRef = adminDb.collection("trades").doc(data.tradeId);
        const tradeSnap = await tradeRef.get();
        
        if (tradeSnap.exists) {
          const tradeData = tradeSnap.data();
          if (tradeData?.userId === data.userId && tradeData?.status === "pending") {
            const userRef = adminDb.collection("users").doc(data.userId);
            const userSnap = await userRef.get();
            
        const result = await adminDb.runTransaction(async (transaction) => {
          const userSnap = await transaction.get(userRef);
          if (!userSnap.exists) throw new Error("User not found");
          
          const userData = userSnap.data();
          const currentBalance = userData?.balance || 0;
          const refundAmount = tradeData.amount;
          
          transaction.update(userRef, { balance: currentBalance + refundAmount });
          transaction.update(tradeRef, { status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
          
          return currentBalance + refundAmount;
        });
        
        io.to(data.userId).emit("balanceUpdate", result);
        emitUserTrades(data.userId);
        emitArenaEvent(`${data.userId.slice(0, 8)} cancelled a pending order`, 'warning');
          }
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `trades/${data.tradeId} (cancel)`);
      }
    });

    socket.on("updateProfile", async (data: { 
      userId: string, 
      name?: string, 
      bio?: string, 
      photoUrl?: string, 
      oneClickTrading?: boolean,
      aiBotAmount?: number,
      aiBotStopLoss?: number,
      aiBotTakeProfit?: number,
      aiBotOrderType?: string,
      isAiBotEnabled?: boolean
    }) => {
      const { adminDb } = getFirebase() || {};
      if (!adminDb) return;
      try {
        const userRef = adminDb.collection("users").doc(data.userId);
        const updates: any = {};
        if (data.name) updates.name = data.name;
        if (data.bio !== undefined) updates.bio = data.bio;
        if (data.photoUrl) updates.photoUrl = data.photoUrl;
        if (data.oneClickTrading !== undefined) updates.oneClickTrading = data.oneClickTrading;
        if (data.aiBotAmount !== undefined) updates.aiBotAmount = data.aiBotAmount;
        if (data.aiBotStopLoss !== undefined) updates.aiBotStopLoss = data.aiBotStopLoss;
        if (data.aiBotTakeProfit !== undefined) updates.aiBotTakeProfit = data.aiBotTakeProfit;
        if (data.aiBotOrderType !== undefined) updates.aiBotOrderType = data.aiBotOrderType;
        if (data.isAiBotEnabled !== undefined) updates.isAiBotEnabled = data.isAiBotEnabled;
        
        await userRef.update(updates);
        const updatedSnap = await userRef.get();
        socket.emit("profileUpdate", updatedSnap.data());
        emitArenaEvent(`${data.userId.slice(0, 8)} updated their profile`, 'info');
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `users/${data.userId} (profile)`);
      }
    });

    socket.on("upgradePremium", async (data: { userId: string }) => {
      const { adminDb } = getFirebase() || {};
      if (!adminDb) return;
      try {
        const userRef = adminDb.collection("users").doc(data.userId);
        await adminDb.runTransaction(async (transaction) => {
          const userSnap = await transaction.get(userRef);
          if (!userSnap.exists) throw new Error("User not found");
          const userData = userSnap.data() as any;
          const cost = 5000; // Premium cost
          
          if (userData.balance < cost) throw new Error("Insufficient balance for Premium");
          
          transaction.update(userRef, { 
            balance: userData.balance - cost,
            isPremium: true 
          });
        });
        
        const updatedSnap = await userRef.get();
        const updatedData = updatedSnap.data() as any;
        io.to(data.userId).emit("balanceUpdate", updatedData.balance);
        socket.emit("profileUpdate", updatedData);
        socket.emit("tradeOpened", { tradeId: "premium", status: "open", message: "Successfully upgraded to PREMIUM!" });
        emitArenaEvent(`${data.userId.slice(0, 8)} upgraded to PREMIUM! 💎`, 'success');
      } catch (error: any) {
        socket.emit("errorMsg", error.message);
      }
    });
  });

  // --- Round Settlement ---
  setInterval(async () => {
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return;
    try {
      // Settle Open Trades (Using Cache)
      // Note: We removed the automatic round settlement to respect trade durations.
      // Trades are now settled solely by the duration-based loop or SL/TP checks.
      
      roundId++;
      nextSettlementAt = Date.now() + 7000;
    } catch (error) {
      console.error("Error in round settlement:", error);
    }
  }, 7000);

  // --- M-PESA Simulation ---
  app.post("/api/deposit", async (req, res) => {
    const { userId, phone, amount, isDemo } = req.body;
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return res.status(503).json({ status: "error", message: "Firebase not initialized" });
    
    try {
      const userRef = adminDb.collection("users").doc(userId);
      const userSnap = await userRef.get();
      
      if (!userSnap.exists) {
        return res.status(404).json({ status: "error", message: "User not found" });
      }

      const transactionRef = adminDb.collection("transactions").doc();
      await transactionRef.set({
        userId,
        phone,
        amount: parseFloat(amount),
        status: "pending",
        type: isDemo ? "demo_deposit" : "mpesa_deposit",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const processDeposit = async () => {
        try {
          const uSnap = await userRef.get();
          if (uSnap.exists) {
            const userData = uSnap.data();
            const newBalance = (userData?.balance || 0) + parseFloat(amount);
            
            await adminDb.runTransaction(async (t) => {
              t.update(userRef, { balance: newBalance });
              t.update(transactionRef, { 
                status: "completed", 
                completedAt: admin.firestore.FieldValue.serverTimestamp() 
              });
            });

            emitArenaEvent(`${userId.slice(0, 8)} deposited KES ${amount.toLocaleString()}`, 'success');

            const socketId = userData?.socketId;
            io.to(userId).emit("balanceUpdate", newBalance);
            io.to(userId).emit("depositStatus", { 
              status: "success", 
              message: `Successfully deposited KES ${amount}`,
              amount: parseFloat(amount)
            });
          }
        } catch (e) {
          console.error("Async deposit processing error:", e);
          await transactionRef.update({ 
            status: "failed", 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      };

      if (isDemo) {
        await processDeposit();
        res.json({ status: "success", message: "Demo funds added" });
      } else {
        // Simulate STK Push delay
        setTimeout(processDeposit, 5000);
        res.json({ 
          status: "success", 
          message: "STK Push initiated", 
          transactionId: transactionRef.id 
        });
      }
    } catch (error) {
      console.error("Deposit route error:", error);
      res.status(500).json({ status: "error", message: "Internal server error" });
    }
  });

  app.post("/api/withdraw", async (req, res) => {
    const { userId, amount, phone } = req.body;
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return res.status(503).json({ status: "error", message: "Firebase not initialized" });

    try {
      const userRef = adminDb.collection("users").doc(userId);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({ status: "error", message: "User not found" });
      }

      const result = await adminDb.runTransaction(async (transaction) => {
        const uSnap = await transaction.get(userRef);
        if (!uSnap.exists) throw new Error("User not found");

        const userData = uSnap.data();
        const currentBalance = userData?.balance || 0;
        const withdrawAmount = parseFloat(amount);

        if (withdrawAmount > currentBalance) {
          throw new Error("Insufficient balance");
        }

        const newBalance = currentBalance - withdrawAmount;
        const transactionRef = adminDb.collection("transactions").doc();
        
        transaction.update(userRef, { balance: newBalance });
        transaction.set(transactionRef, {
          userId,
          phone,
          amount: withdrawAmount,
          status: "completed",
          type: "withdrawal",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return newBalance;
      });

      emitArenaEvent(`${userId.slice(0, 8)} withdrew KES ${parseFloat(amount).toLocaleString()}`, 'warning');

      io.to(userId).emit("balanceUpdate", result);
      io.to(userId).emit("arenaEvent", {
        id: generateId(),
        message: `Withdrawal of KES ${amount} successful!`,
        type: 'success',
        time: new Date().toLocaleTimeString()
      });

      res.json({ status: "success", message: "Withdrawal successful", newBalance: result });
    } catch (error: any) {
      if (error.message === "Insufficient balance") {
        res.status(400).json({ status: "error", message: "Insufficient balance" });
      } else {
        console.error("Withdrawal route error:", error);
        res.status(500).json({ status: "error", message: "Internal server error" });
      }
    }
  });

  app.post("/api/renew-balance", async (req, res) => {
    const { userId } = req.body;
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return res.status(503).json({ status: "error", message: "Firebase not initialized" });

    try {
      const userRef = adminDb.collection("users").doc(userId);
      
      const result = await adminDb.runTransaction(async (transaction) => {
        const uSnap = await transaction.get(userRef);
        if (!uSnap.exists) throw new Error("User not found");

        const userData = uSnap.data();
        const lastRenewal = userData?.lastRenewal?.toDate() || new Date(0);
        const now = new Date();
        const diffMs = now.getTime() - lastRenewal.getTime();
        const diffHrs = diffMs / (1000 * 60 * 60);

        if (diffHrs < 24) {
          throw new Error(`Balance can only be renewed once every 24 hours. Please wait ${Math.ceil(24 - diffHrs)} more hours.`);
        }

        const newBalance = 10000;
        transaction.update(userRef, { 
          balance: newBalance,
          lastRenewal: admin.firestore.FieldValue.serverTimestamp()
        });

        return newBalance;
      });

      emitArenaEvent(`${userId.slice(0, 8)} renewed their demo balance to KES 10,000`, 'info');

      io.to(userId).emit("balanceUpdate", result);
      io.to(userId).emit("arenaEvent", {
        id: generateId(),
        message: "Demo balance renewed to KES 10,000!",
        type: 'success',
        time: new Date().toLocaleTimeString()
      });

      res.json({ status: "success", message: "Balance renewed", newBalance: result });
    } catch (error: any) {
      if (error.message.includes("Balance can only be renewed")) {
        res.status(400).json({ status: "error", message: error.message });
      } else {
        console.error("Renew balance route error:", error);
        res.status(500).json({ status: "error", message: "Internal server error" });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // --- Global Simulation Bots ---
  // --- Bot Rotation & Continuous Feed ---
  const rotateLeaderboardBots = async () => {
    const { adminDb } = getFirebase() || {};
    if (!adminDb) return;
    try {
      const botsSnap = await adminDb.collection("users").where("role", "==", "bot").get();
      for (const doc of botsSnap.docs) {
        const currentBalance = doc.data().balance || 10000;
        // Randomly fluctuate bot balance to simulate trading activity
        const fluctuation = (Math.random() - 0.45) * 500; // Slightly biased towards profit
        const newBalance = Math.max(1000, currentBalance + fluctuation);
        await doc.ref.update({ balance: newBalance });
      }
      console.log("Leaderboard bots rotated.");
    } catch (error) {
      console.error("Error rotating bots:", error);
    }
  };

  // Rotate bots every 1 minute
  setInterval(rotateLeaderboardBots, 60000);

  const startSimulationBots = async () => {
    const { db } = getFirebase() || {};
    if (!db) {
      console.error("Simulation Bots: Firebase not initialized, bots will not start.");
      return;
    }
    
    const botConfigs = [
      { id: "sim_bot_alpha", name: "Alpha Scalper", strategy: "scalp" },
      { id: "sim_bot_beta", name: "Beta Trend", strategy: "trend" },
      { id: "sim_bot_gamma", name: "Gamma Whale", strategy: "whale" },
      { id: "sim_bot_delta", name: "Delta Swing", strategy: "swing" },
      { id: "sim_bot_epsilon", name: "Epsilon Arbitrage", strategy: "scalp" },
      { id: "sim_bot_zeta", name: "Zeta Momentum", strategy: "trend" },
      { id: "sim_bot_eta", name: "Eta Reversal", strategy: "swing" },
      { id: "sim_bot_theta", name: "Theta Grid", strategy: "scalp" },
      { id: "sim_bot_iota", name: "Iota Breakout", strategy: "trend" },
      { id: "sim_bot_kappa", name: "Kappa Sniper", strategy: "scalp" },
      { id: "sim_bot_lambda", name: "Lambda Liquidity", strategy: "scalp" },
      { id: "sim_bot_mu", name: "Mu Macro", strategy: "trend" },
      { id: "sim_bot_nu", name: "Nu News", strategy: "swing" },
      { id: "sim_bot_xi", name: "Xi X-Ray", strategy: "scalp" },
      { id: "sim_bot_omicron", name: "Omicron Option", strategy: "trend" }
    ];

    for (const bot of botConfigs) {
      try {
        const { adminDb } = getFirebase() || {};
        if (!adminDb) continue;
        const botRef = adminDb.collection("users").doc(bot.id);
        const botSnap = await botRef.get();
        
        if (!botSnap.exists) {
          console.log(`Simulation Bot: Creating ${bot.name}...`);
          await botRef.set({
            userId: bot.id,
            balance: bot.strategy === "whale" ? 5000000 : 1000000,
            socketId: null,
            role: "bot",
            name: bot.name,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        // Different intervals for different strategies (Highly active for engagement)
        const interval = bot.strategy === "scalp" ? 6000 + Math.random() * 4000 : 
                         bot.strategy === "whale" ? 30000 + Math.random() * 15000 : 
                         bot.strategy === "trend" ? 15000 + Math.random() * 10000 : 
                         20000 + Math.random() * 10000;

        setInterval(async () => {
          const { adminDb } = getFirebase() || {};
          if (!adminDb) return;
          try {
            const directions: ("buy" | "sell")[] = ["buy", "sell"];
            const orderTypes: ("market" | "limit" | "stop")[] = ["market", "limit", "stop"];
            const durations = ["30s", "1m", "5m"];
            
            const direction = directions[Math.floor(Math.random() * directions.length)];
            const type = Math.random() > 0.8 ? orderTypes[Math.floor(Math.random() * orderTypes.length)] : "market";
            const duration = durations[Math.floor(Math.random() * durations.length)];
            
            let amount = 500 + Math.floor(Math.random() * 4500);
            if (bot.strategy === "whale") amount *= 20;
            
            let target = price;
            if (type === "limit") {
              target = direction === "buy" ? price * (1 - Math.random() * 0.005) : price * (1 + Math.random() * 0.005);
            } else if (type === "stop") {
              target = direction === "buy" ? price * (1 + Math.random() * 0.005) : price * (1 - Math.random() * 0.005);
            }

            const isMarket = type === "market";
            const status = isMarket ? "open" : "pending";
            const entry = isMarket ? price : target;

            const botCommentary = [
              `analyzing market volatility...`,
              `detecting ${direction === 'buy' ? 'bullish' : 'bearish'} divergence...`,
              `executing ${bot.strategy} strategy...`,
              `following institutional flow...`,
              `scalping micro-movements...`
            ];
            const commentary = botCommentary[Math.floor(Math.random() * botCommentary.length)];

            console.log(`Simulation Bot (${bot.name}): Placing ${type} ${direction} trade...`);
            const confirmedAt = Date.now() - Math.floor(Math.random() * 50);
            await adminDb.collection("trades").add({
              userId: bot.id,
              direction,
              amount,
              entry: parseFloat(entry.toFixed(2)),
              status,
              roundId,
              stopLoss: bot.strategy === "scalp" ? 2 : 5 + Math.floor(Math.random() * 10),
              takeProfit: bot.strategy === "scalp" ? 4 : 10 + Math.floor(Math.random() * 20),
              pattern: `${bot.name} (${bot.strategy}): ${commentary}`,
              orderType: type,
              targetPrice: parseFloat(target.toFixed(2)),
              duration,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              executionLatency: Date.now() - confirmedAt,
              isBot: true
            });

            emitArenaEvent(`${bot.name} ${commentary} - ${type.toUpperCase()} ${direction.toUpperCase()} @ ${entry.toFixed(2)}`, 'info');

            if (isMarket) {
              emitGlobalTrades();
            }
          } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, `trades (bot: ${bot.name})`);
          }
        }, interval);
      } catch (error) {
        console.error(`Error starting simulation bot ${bot.name}:`, error);
      }
    }
  };

  startSimulationBots();

  // --- Market News & Bot Chat Simulation ---
  const NEWS_TEMPLATES = [
    { message: "Central Bank announces interest rate decision soon.", impact: "high" },
    { message: "Tech sector earnings exceed expectations.", impact: "medium" },
    { message: "Global supply chain disruptions reported.", impact: "high" },
    { message: "New trade agreement signed between major economies.", impact: "medium" },
    { message: "Unemployment rates hit record lows.", impact: "low" },
    { message: "Inflation data shows cooling trend.", impact: "medium" },
    { message: "Major tech firm announces breakthrough in AI.", impact: "high" },
    { message: "Oil prices fluctuate amid geopolitical tensions.", impact: "medium" }
  ];

  const BOT_CHATS = [
    "This volatility is insane! 🚀",
    "Just hit my take profit on that last scalp. Easy gains.",
    "Anyone seeing that head and shoulders pattern forming?",
    "Market feels overbought here, looking for a short entry.",
    "ZuriTrade execution speed is top notch today.",
    "Whales are moving in, watch the volume!",
    "Patience is key in this range.",
    "Just doubled my demo balance! 💰",
    "Bear trap detected. Staying long.",
    "Who else is riding this trend?"
  ];

  setInterval(() => {
    const isNews = Math.random() > 0.4;
    if (isNews) {
      const news = NEWS_TEMPLATES[Math.floor(Math.random() * NEWS_TEMPLATES.length)];
      emitArenaEvent(`NEWS: ${news.message}`, news.impact === 'high' ? 'warning' : 'info');
      
      if (news.impact === 'high') {
        const impact = (Math.random() - 0.5) * 5;
        price += impact;
        price = parseFloat(price.toFixed(2));
        emitArenaEvent(`Market reacting to news: ${impact > 0 ? 'Bullish' : 'Bearish'} momentum detected`, impact > 0 ? 'success' : 'danger');
      }
    } else {
      const botNames = ["Alpha Scalper", "Beta Trend", "Gamma Whale", "Delta Swing", "Epsilon Arbitrage", "Zeta Momentum"];
      const bot = botNames[Math.floor(Math.random() * botNames.length)];
      const chat = BOT_CHATS[Math.floor(Math.random() * BOT_CHATS.length)];
      emitArenaEvent(`${bot}: "${chat}"`, 'info');
    }
  }, 30000); // Activity every 30 seconds

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
