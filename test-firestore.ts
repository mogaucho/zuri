import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

async function test() {
  try {
    const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf-8'));
    console.log('Config:', config);

    const app = initializeApp({
      credential: applicationDefault(),
      projectId: config.projectId
    });

    console.log(`Testing firebase-admin with (default) database...`);
    const dbDefault = getFirestore(app);
    const snapDefault = await dbDefault.collection('users').limit(1).get();
    console.log('   Success! Found', snapDefault.docs.length, 'users.');
    process.exit(0);
  } catch (error) {
    console.error('   Failed:', error.message);
    process.exit(1);
  }
}

test();
