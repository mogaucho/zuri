import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import path from "path";
import cors from "cors";
import fs from "fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Load Firebase Config
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));

console.log("Initializing Firebase Admin and Firestore with:", {
  projectId: firebaseConfig.projectId,
  databaseId: firebaseConfig.firestoreDatabaseId,
});

// Initialize Firebase Admin for Auth and other services
const adminApp = initializeApp({
  credential: applicationDefault(),
});

// Initialize Firestore using firebase-admin/firestore
// The projectId is inferred from the environment in Cloud Run
const db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" },
  });

  // --- Helper Functions for Real-time Updates ---
  const emitUserTrades = async (userId: string) => {
    try {
      const tradesRef = db.collection("trades");
      
      // Active Trades (Open or Pending)
      const activeSnap = await tradesRef
        .where("userId", "==", userId)
        .where("status", "in", ["open", "pending"])
        .get();
      
      const activeTrades = activeSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      // User Trade History
      const historySnap = await tradesRef
        .where("userId", "==", userId)
        .where("status", "==", "closed")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();
      
      const tradeHistory = historySnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      const userRef = db.collection("users").doc(userId);
      const userSnap = await userRef.get();
      const socketId = userSnap.data()?.socketId;
      
      if (socketId) {
        io.to(socketId).emit("userTradesUpdate", { activeTrades, tradeHistory });
      }
    } catch (error) {
      console.error("Error emitting user trades:", error);
    }
  };

  const emitGlobalTrades = async () => {
    try {
      const tradesRef = db.collection("trades");
      const globalSnap = await tradesRef
        .orderBy("createdAt", "desc")
        .limit(20)
        .get();
      
      const globalTrades = globalSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      io.emit("globalTradesUpdate", globalTrades);
    } catch (error) {
      console.error("Error emitting global trades:", error);
    }
  };

  // --- Price Engine ---
  let price = 100.0;
  let roundId = 1;
  setInterval(async () => {
    price += (Math.random() - 0.5) * 0.5;
    price = parseFloat(price.toFixed(2));
    io.emit("priceUpdate", { price, roundId });

    // 1. Check Pending Orders
    try {
      const tradesRef = db.collection("trades");
      const pendingTrades = await tradesRef.where("status", "==", "pending").get();
      for (const tradeDoc of pendingTrades.docs) {
        const t = tradeDoc.data();
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
          await tradeDoc.ref.update({ 
            status: "open", 
            entry: price,
            roundId: roundId,
            executedAt: FieldValue.serverTimestamp() 
          });
          emitUserTrades(t.userId);
        }
      }
    } catch (error) {
      console.error("Error checking pending orders:", error);
    }

    // 2. Check for Stop Loss / Take Profit hits
    try {
      const tradesRef = db.collection("trades");
      const q = await tradesRef.where("status", "==", "open").get();

      for (const tradeDoc of q.docs) {
        const trade = tradeDoc.data();
        const { direction, entry, stopLoss, takeProfit, userId, amount } = trade;
        
        // Calculate profit based on price change percentage
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
          const userRef = db.collection("users").doc(userId);
          const userSnap = await userRef.get();
          if (userSnap.exists) {
            const userData = userSnap.data();
            // Profit is percentage of the amount
            const profit = (profitPct / 100) * amount;
            const newBalance = (userData?.balance || 0) + amount + profit;
            
            await userRef.update({ balance: newBalance });
            await tradeDoc.ref.update({ status: "closed", exitPrice: price, closeReason: reason });
            
            const socketId = userData?.socketId;
            if (socketId) {
              io.to(socketId).emit("tradeClosed", { profit, balance: newBalance, reason });
            }
            // Emit updates
            emitUserTrades(userId);
            emitGlobalTrades();
          }
        }
      }
    } catch (error) {
      console.error("Error checking SL/TP:", error);
    }
  }, 1000);

  // --- Socket Logic ---
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("register", async (userId) => {
      try {
        const userRef = db.collection("users").doc(userId);
        const userSnap = await userRef.get();
        
        if (!userSnap.exists) {
          await userRef.set({
            userId,
            balance: 10000,
            socketId: socket.id,
            role: "user",
            createdAt: FieldValue.serverTimestamp()
          });
          socket.emit("balanceUpdate", 10000);
        } else {
          await userRef.update({ socketId: socket.id });
          socket.emit("balanceUpdate", userSnap.data()?.balance);
        }
        socket.emit("priceUpdate", { price, roundId });
        
        // Initial trades update
        emitUserTrades(userId);
        emitGlobalTrades();
      } catch (error) {
        console.error("Error registering user:", error);
      }
    });

    socket.on("openTrade", async (data) => {
      try {
        const userRef = db.collection("users").doc(data.userId);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return;

        const userData = userSnap.data();
        const balance = userData?.balance || 0;
        if (data.amount > balance) {
          socket.emit("errorMsg", "Insufficient balance");
          return;
        }

        const isMarket = !data.orderType || data.orderType === "market";
        const status = isMarket ? "open" : "pending";
        const entry = isMarket ? price : data.targetPrice;

        const newBalance = balance - data.amount;
        await userRef.update({ balance: newBalance });
        
        await db.collection("trades").add({
          userId: data.userId,
          direction: data.direction,
          amount: data.amount,
          entry: entry,
          status: status,
          roundId,
          stopLoss: data.stopLoss || null,
          takeProfit: data.takeProfit || null,
          pattern: data.pattern || "None",
          orderType: data.orderType || "market",
          targetPrice: data.targetPrice || null,
          createdAt: FieldValue.serverTimestamp()
        });

        socket.emit("balanceUpdate", newBalance);
        emitUserTrades(data.userId);
      } catch (error) {
        console.error("Error opening trade:", error);
      }
    });
  });

  // --- Round Settlement ---
  setInterval(async () => {
    try {
      const tradesRef = db.collection("trades");
      
      // Settle Open Trades
      const querySnapshot = await tradesRef
        .where("status", "==", "open")
        .where("roundId", "==", roundId)
        .get();

      const affectedUsers = new Set<string>();

      for (const tradeDoc of querySnapshot.docs) {
        const trade = tradeDoc.data();
        const userRef = db.collection("users").doc(trade.userId);
        const userSnap = await userRef.get();
        
        if (userSnap.exists) {
          const userData = userSnap.data();
          // Calculate profit based on price change percentage
          const profitPct = trade.direction === "buy" ? (price - trade.entry) / trade.entry * 100 : (trade.entry - price) / trade.entry * 100;
          const profit = (profitPct / 100) * trade.amount;
          
          const newBalance = (userData?.balance || 0) + trade.amount + profit;
          
          await userRef.update({ balance: newBalance });
          await tradeDoc.ref.update({ status: "closed", exitPrice: price, closeReason: "Round Settlement" });
          
          const socketId = userData?.socketId;
          if (socketId) {
            io.to(socketId).emit("tradeClosed", { profit, balance: newBalance, reason: "Round Settlement" });
          }
          affectedUsers.add(trade.userId);
        }
      }

      for (const userId of affectedUsers) {
        emitUserTrades(userId);
      }
      if (affectedUsers.size > 0) {
        emitGlobalTrades();
      }

      roundId++;
      
      // Update Leaderboard
      const usersSnap = await db.collection("users").get();
      const leaderboard = usersSnap.docs
        .map(doc => ({ userId: doc.data().userId, balance: doc.data().balance }))
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10);
      
      io.emit("leaderboardUpdate", leaderboard);
    } catch (error) {
      console.error("Error in round settlement:", error);
    }
  }, 30000);

  // --- M-PESA Simulation ---
  app.post("/api/deposit", async (req, res) => {
    const { userId, phone, amount, isDemo } = req.body;
    
    try {
      const userRef = db.collection("users").doc(userId);
      const userSnap = await userRef.get();
      
      if (!userSnap.exists) {
        return res.status(404).json({ status: "error", message: "User not found" });
      }

      const transactionRef = db.collection("transactions").doc();
      await transactionRef.set({
        userId,
        phone,
        amount: parseFloat(amount),
        status: "pending",
        type: isDemo ? "demo_deposit" : "mpesa_deposit",
        createdAt: FieldValue.serverTimestamp()
      });

      const processDeposit = async () => {
        try {
          const uSnap = await userRef.get();
          if (uSnap.exists) {
            const userData = uSnap.data();
            const newBalance = (userData?.balance || 0) + parseFloat(amount);
            
            await db.runTransaction(async (t) => {
              t.update(userRef, { balance: newBalance });
              t.update(transactionRef, { status: "completed", completedAt: FieldValue.serverTimestamp() });
            });

            const socketId = userData?.socketId;
            if (socketId) {
              io.to(socketId).emit("balanceUpdate", newBalance);
              io.to(socketId).emit("depositStatus", { 
                status: "success", 
                message: `Successfully deposited KES ${amount}`,
                amount: parseFloat(amount)
              });
            }
          }
        } catch (e) {
          console.error("Async deposit processing error:", e);
          await transactionRef.update({ status: "failed", error: e instanceof Error ? e.message : String(e) });
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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
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

  // --- Global Simulation Bot ---
  const startSimulationBot = async () => {
    const botId = "sim_bot_001";
    const botRef = db.collection("users").doc(botId);
    const botSnap = await botRef.get();
    
    if (!botSnap.exists) {
      await botRef.set({
        userId: botId,
        balance: 1000000,
        socketId: null,
        role: "bot",
        createdAt: FieldValue.serverTimestamp()
      });
    }

    setInterval(async () => {
      try {
        const directions: ("buy" | "sell")[] = ["buy", "sell"];
        const orderTypes: ("market" | "limit" | "stop")[] = ["market", "limit", "stop"];
        
        const direction = directions[Math.floor(Math.random() * directions.length)];
        const type = orderTypes[Math.floor(Math.random() * orderTypes.length)];
        const amount = 100 + Math.floor(Math.random() * 900);
        
        let target = price;
        if (type === "limit") {
          target = direction === "buy" ? price * 0.995 : price * 1.005;
        } else if (type === "stop") {
          target = direction === "buy" ? price * 1.005 : price * 0.995;
        }

        const isMarket = type === "market";
        const status = isMarket ? "open" : "pending";
        const entry = isMarket ? price : target;

        await db.collection("trades").add({
          userId: botId,
          direction,
          amount,
          entry: parseFloat(entry.toFixed(2)),
          status,
          roundId,
          stopLoss: 3 + Math.floor(Math.random() * 5),
          takeProfit: 5 + Math.floor(Math.random() * 10),
          pattern: "Bot Simulation",
          orderType: type,
          targetPrice: parseFloat(target.toFixed(2)),
          createdAt: FieldValue.serverTimestamp()
        });

        if (isMarket) {
          emitGlobalTrades();
        }
      } catch (error) {
        console.error("Simulation Bot Error:", error);
      }
    }, 20000); // Bot trades every 20 seconds
  };

  startSimulationBot();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
