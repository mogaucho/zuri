import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, limit, query, doc, setDoc, orderBy } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import fs from "fs";

async function test() {
  try {
    const config = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
    console.log("Config:", config);

    const app = initializeApp(config);
    const db = getFirestore(app, config.firestoreDatabaseId);

    console.log(`Checking Leaderboard...`);
    const usersRef = collection(db, "users");
    const uq = query(usersRef, orderBy("balance", "desc"), limit(5));
    const usnap = await getDocs(uq);
    usnap.docs.forEach(doc => {
      const data = doc.data();
      console.log(`   User: ${data.name || data.userId} | Balance: ${data.balance}`);
    });
    process.exit(0);
  } catch (error) {
    console.error("   Failed:", error.message);
    process.exit(1);
  }
}

test();
