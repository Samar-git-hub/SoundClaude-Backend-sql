import dotenv from 'dotenv';
import fetch from 'node-fetch';
import axios from 'axios';
import fs from 'fs';
import { Readable } from 'stream';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { connectToDatabase, closeConnection } from './db.js';
import { GridFSBucket, ObjectId } from 'mongodb';
import path from 'path';

dotenv.config();

// Replace Hugging Face with Google AI initialization
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

// URL of the song to fetch and encode
const songUrl = 'https://raw.githubusercontent.com/Samar-git-hub/songs_mp3/main/Cartoon_On_%26_On%20_(feat.%20Daniel%20Levi)_%5BNCS%20Release%5D.mp3';

// Sonoteller API params
const encodedParams = new URLSearchParams();
encodedParams.set('file', songUrl);

const apiUrl = 'https://sonoteller-ai1.p.rapidapi.com/lyrics_ddex';
const apiOptions = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': process.env.RAPID_API_KEY,
    'x-rapidapi-host': 'sonoteller-ai1.p.rapidapi.com',
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: encodedParams
};

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function uploadToGridFS(buffer, filename, db) {
  const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });
  const uploadStream = bucket.openUploadStream(filename);
  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);
  return new Promise((resolve, reject) => {
    readable.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

async function getSongBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function songExists(url) {
  const db = await connectToDatabase();
  const collection = db.collection('songs');
  const song = await collection.findOne({ songUrl: url });
  return song !== null;
}

function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

async function fetchLyricsAndStore() {
  const db = await connectToDatabase();
  try {
    const exists = await songExists(songUrl);
    if (exists) {
      console.log('Song already exists in the database.');
      return;
    }

    console.log('Making API request...');
    const response = await fetch(apiUrl, apiOptions);
    
    // Add this to see the raw response
    const responseText = await response.text();
    console.log('Raw API Response:', responseText);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} - ${responseText}`);
    }

    // Try to parse JSON only if we know it's JSON
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${responseText}`);
    }

    const combinedText = [
      result.summary,
      ...Object.values(result.keywords || {}),
      ...Object.values(result['ddex moods'] || {}),
      ...Object.values(result['ddex themes'] || {})
    ].join(' ');

    // Replace Hugging Face embedding with Google's
    const embeddingResponse = await embedModel.embedContent(combinedText);
    const embedding = embeddingResponse.embedding.values;

    const songBuffer = await getSongBuffer(songUrl);
    const fileName = path.basename(songUrl);
    const gridFSId = await uploadToGridFS(songBuffer, fileName, db);

    const songData = {
      songUrl: songUrl,
      audioFileId: gridFSId,
      filename: fileName,
      language: result.language,
      language_iso: result["language-iso"],
      summary: result.summary,
      explicit: result.explicit,
      keywords: Object.values(result.keywords),
      ddex_moods: Object.values(result["ddex moods"]),
      ddex_themes: Object.values(result["ddex themes"]),
      flags: result.flags,
      embedding: embedding,  // Using Google's embedding
      created_at: new Date(),
    };

    const collection = db.collection('songs');
    const insertResult = await collection.insertOne(songData);
    console.log('Inserted song into DB with ID:', insertResult.insertedId);
  } catch (error) {
    console.error('Error in fetchLyricsAndStore:', error);
  } finally {
    await closeConnection();
  }
}

async function findSimilarSongs(queryText) {
  const embeddingResponse = await embedModel.embedContent(queryText);
  const queryEmbedding = embeddingResponse.embedding.values;

  const db = await connectToDatabase();
  const collection = db.collection('songs');

  const songs = await collection.find({}).toArray();
  const similarities = songs.map(song => {
    const similarity = cosineSimilarity(queryEmbedding, song.embedding);
    return { songId: song._id, similarity, songData: song };
  });

  similarities.sort((a, b) => b.similarity - a.similarity);
  const topSongs = similarities.slice(0, 5);

  console.log('\n🔍 Search Results for:', queryText);
  console.log('═══════════════════════════════════════════\n');

  topSongs.forEach((song, index) => {
    console.log(`${index + 1}. ${song.songData.filename.replace(/_/g, ' ').replace('.mp3', '')}`);
    console.log(`   Similarity: ${(song.similarity * 100).toFixed(1)}%`);
    console.log(`   Keywords: ${song.songData.keywords.join(', ')}`);
    console.log(`   Moods: ${song.songData.ddex_moods.join(', ')}`);
    console.log(`   Summary: ${song.songData.summary.slice(0, 150)}...`);
    console.log('───────────────────────────────────────────\n');
  });

  await closeConnection();
  return topSongs;
}

async function downloadSongFromGridFS(fileId, outputPath = './downloaded_song.mp3') {
  const db = await connectToDatabase();
  const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });

  return new Promise((resolve, reject) => {
    const downloadStream = bucket.openDownloadStream(new ObjectId(fileId));
    const writeStream = fs.createWriteStream(outputPath);
    downloadStream.pipe(writeStream)
      .on('error', reject)
      .on('finish', () => {
        console.log('✅ Download complete:', outputPath);
        resolve(outputPath);
      });
  });
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'add':
            console.log('Adding new song to database...');
            await fetchLyricsAndStore();
            break;

        case 'search':
            const searchQuery = args.slice(1).join(' ');
            if (!searchQuery) {
                console.log('Please provide search terms. Example:');
                console.log('node index.js search love journey happiness');
                return;
            }
            console.log(`Searching for songs similar to: "${searchQuery}"`);
            await findSimilarSongs(searchQuery);
            break;

        default:
            console.log('Please use one of these commands:');
            console.log('1. To add a new song:');
            console.log('   node index.js add');
            console.log('2. To search for similar songs:');
            console.log('   node index.js search your search terms here');
    }
}

await main();