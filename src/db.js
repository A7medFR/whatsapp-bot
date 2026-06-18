'use strict';

const path = require('path');

let activeDbType = null; // 'firestore' | 'mongodb' | 'postgres' | null
let initError = null;

// Firestore variables
let firestoreDb = null;

// MongoDB variables
let mongoClient = null;
let mongoDb = null;

// PostgreSQL variables
let pgClient = null;

/**
 * Detects the configured database and initializes the connection.
 */
async function init() {
  // 1. Check for Firebase Firestore
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const admin = require('firebase-admin');
      let serviceAccount;
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (raw.startsWith('{')) {
        serviceAccount = JSON.parse(raw);
      } else {
        serviceAccount = require(path.resolve(raw));
      }

      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      }
      firestoreDb = admin.firestore();
      activeDbType = 'firestore';
      console.log('🔥 [DB] Persistent Firebase Firestore integration initialized.');
      return;
    } catch (err) {
      console.error('❌ [DB] Failed to initialize Firebase Firestore:', err.message);
      initError = err.message;
      throw err;
    }
  }

  // 2. Check for MongoDB
  if (process.env.MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      mongoClient = new MongoClient(process.env.MONGODB_URI);
      await mongoClient.connect();
      mongoDb = mongoClient.db();
      activeDbType = 'mongodb';
      console.log('🍃 [DB] Persistent MongoDB integration initialized.');
      return;
    } catch (err) {
      console.error('❌ [DB] Failed to initialize MongoDB:', err.message);
      initError = err.message;
      throw err;
    }
  }

  // 3. Check for PostgreSQL
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      pgClient = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false // Required for Render Postgres
        }
      });
      await pgClient.connect();
      // Ensure the table exists
      await pgClient.query(`
        CREATE TABLE IF NOT EXISTS complaints (
          ticket_id VARCHAR(100) PRIMARY KEY,
          phone VARCHAR(50),
          status VARCHAR(20),
          data JSONB,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      activeDbType = 'postgres';
      console.log('🐘 [DB] Persistent PostgreSQL integration initialized.');
      return;
    } catch (err) {
      console.error('❌ [DB] Failed to initialize PostgreSQL:', err.message);
      initError = err.message;
      throw err;
    }
  }

  // Fallback
  console.log('⚠️ [DB] No persistent database configured in environment. Storing complaints in local JSON fallback.');
  activeDbType = null;
}

/**
 * Retrieves all complaints from the configured database.
 * Returns null if no database is configured (forces fallback to local file).
 */
async function getComplaints() {
  if (!activeDbType) return null;

  try {
    switch (activeDbType) {
      case 'firestore':
        return await getFirestoreComplaints();
      case 'mongodb':
        return await getMongoComplaints();
      case 'postgres':
        return await getPostgresComplaints();
      default:
        return null;
    }
  } catch (err) {
    console.error(`❌ [DB] Failed to fetch complaints from database (${activeDbType}):`, err.message);
    throw err;
  }
}

/**
 * Synchronizes the entire complaints list with the active database.
 */
async function saveComplaints(list) {
  if (!activeDbType) return;

  try {
    switch (activeDbType) {
      case 'firestore':
        await saveFirestoreComplaints(list);
        break;
      case 'mongodb':
        await saveMongoComplaints(list);
        break;
      case 'postgres':
        await savePostgresComplaints(list);
        break;
    }
    console.log(`✅ [DB] Successfully synchronized ${list.length} complaint(s) to ${activeDbType}.`);
  } catch (err) {
    console.error(`❌ [DB] Failed to save complaints to database (${activeDbType}):`, err.message);
    throw err;
  }
}

// ─── Firebase Firestore Provider ──────────────────────────────────────────────

async function getFirestoreComplaints() {
  const snapshot = await firestoreDb.collection('complaints').get();
  const complaints = [];
  snapshot.forEach(doc => {
    complaints.push(doc.data());
  });
  return complaints;
}

async function saveFirestoreComplaints(list) {
  const collectionRef = firestoreDb.collection('complaints');
  const activeIds = list.map(c => c.ticketId).filter(Boolean);

  // Find documents to delete
  const snapshot = await collectionRef.get();
  const dbIds = [];
  snapshot.forEach(doc => dbIds.push(doc.id));
  const idsToDelete = dbIds.filter(id => !activeIds.includes(id));

  const chunkArray = (arr, size) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  };

  // Delete obsolete documents in batches of 400
  if (idsToDelete.length > 0) {
    const deleteChunks = chunkArray(idsToDelete, 400);
    for (const chunk of deleteChunks) {
      const batch = firestoreDb.batch();
      for (const id of chunk) {
        batch.delete(collectionRef.doc(id));
      }
      await batch.commit();
    }
  }

  // Upsert active documents in batches of 400
  if (list.length > 0) {
    const writeChunks = chunkArray(list, 400);
    for (const chunk of writeChunks) {
      const batch = firestoreDb.batch();
      for (const c of chunk) {
        const docRef = collectionRef.doc(c.ticketId);
        batch.set(docRef, c, { merge: true });
      }
      await batch.commit();
    }
  }
}

// ─── MongoDB Provider ─────────────────────────────────────────────────────────

async function getMongoComplaints() {
  const collection = mongoDb.collection('complaints');
  return await collection.find({}, { projection: { _id: 0 } }).toArray();
}

async function saveMongoComplaints(list) {
  const collection = mongoDb.collection('complaints');
  const activeIds = list.map(c => c.ticketId).filter(Boolean);

  // Delete obsolete documents
  await collection.deleteMany({ ticketId: { $nin: activeIds } });

  // Bulk upsert current documents
  if (list.length > 0) {
    const operations = list.map(c => ({
      updateOne: {
        filter: { ticketId: c.ticketId },
        update: { $set: c },
        upsert: true
      }
    }));
    await collection.bulkWrite(operations);
  }
}

// ─── PostgreSQL Provider ──────────────────────────────────────────────────────

async function getPostgresComplaints() {
  const res = await pgClient.query('SELECT data FROM complaints');
  return res.rows.map(r => r.data);
}

async function savePostgresComplaints(list) {
  const activeIds = list.map(c => c.ticketId).filter(Boolean);

  if (activeIds.length > 0) {
    // Delete obsolete records
    const placeholders = activeIds.map((_, i) => `$${i + 1}`).join(',');
    await pgClient.query(`DELETE FROM complaints WHERE ticket_id NOT IN (${placeholders})`, activeIds);

    // Upsert current records
    for (const c of list) {
      await pgClient.query(`
        INSERT INTO complaints (ticket_id, phone, status, data, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (ticket_id) 
        DO UPDATE SET phone = $2, status = $3, data = $4, updated_at = NOW()
      `, [c.ticketId, c.phone || c.senderPhone || '', c.status || 'OPEN', JSON.stringify(c)]);
    }
  } else {
    await pgClient.query('DELETE FROM complaints');
  }
}

function getActiveDbType() {
  return activeDbType;
}

function getInitError() {
  return initError;
}

module.exports = { init, getComplaints, saveComplaints, getActiveDbType, getInitError };
