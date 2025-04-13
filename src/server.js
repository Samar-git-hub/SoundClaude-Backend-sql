// server.js - place inside src folder
// Install these packages if not already installed:
// npm install express multer cors axios form-data

import express from 'express';
import multer from 'multer';
import path from 'path';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { connectToDatabase, closeConnection } from './db.js';
import { GridFSBucket, ObjectId } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

// Initialize your existing stuff
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

// Set up Express
const app = express();
app.use(cors());
app.use(express.json());

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original filename but ensure uniqueness
    const uniqueName = `${Date.now()}-${path.basename(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

// Serve files from uploads directory (for local testing)
app.use('/uploads', express.static(uploadDir));

// Function to upload file to Catbox.moe
async function uploadToCatbox(filePath, filename) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(filePath), filename);

  console.log('Uploading to Catbox.moe...');
  try {
    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log('File uploaded to:', response.data);
    return response.data; // This returns the direct URL
  } catch (error) {
    console.error('Catbox upload error:', error);
    throw error;
  }
}

// Process uploaded song with Sonoteller
async function processWithSonoteller(songUrl) {
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

  console.log('Making API request to Sonoteller...');
  console.log('Using URL:', songUrl);
  
  const response = await fetch(apiUrl, apiOptions);
  
  const responseText = await response.text();
  
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} - ${responseText}`);
  }

  let result;
  try {
    result = JSON.parse(responseText);
    return result;
  } catch (e) {
    throw new Error(`Invalid JSON response: ${responseText}`);
  }
}

// Upload song to GridFS
async function uploadToGridFS(filePath, filename) {
  const db = await connectToDatabase();
  const buffer = fs.readFileSync(filePath);
  const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });
  
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename);
    const readStream = fs.createReadStream(filePath);
    
    readStream.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

// Store song data in MongoDB
async function storeSongData(songData, fileId, filename, songUrl) {
  const db = await connectToDatabase();
  
  try {
    const combinedText = [
      songData.summary || '',
      ...Object.values(songData.keywords || {}),
      ...Object.values(songData['ddex moods'] || {}),
      ...Object.values(songData['ddex themes'] || {})
    ].join(' ');

    // Get embedding
    const embeddingResponse = await embedModel.embedContent(combinedText);
    const embedding = embeddingResponse.embedding.values;

    // Create song document
    const song = {
      songUrl: songUrl,
      audioFileId: fileId,
      filename: filename,
      language: songData.language || 'unknown',
      language_iso: songData["language-iso"] || 'unknown',
      summary: songData.summary || '',
      explicit: songData.explicit || false,
      keywords: Object.values(songData.keywords || {}),
      ddex_moods: Object.values(songData["ddex moods"] || {}),
      ddex_themes: Object.values(songData["ddex themes"] || {}),
      flags: songData.flags || {},
      embedding: embedding,
      created_at: new Date(),
    };

    const collection = db.collection('songs');
    const result = await collection.insertOne(song);
    return result.insertedId;
  } finally {
    await closeConnection();
  }
}

// Upload endpoint
app.post('/upload', upload.single('songFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`File uploaded locally: ${req.file.originalname}`);

    try {
      // Upload to Catbox.moe to get a public URL
      const songUrl = await uploadToCatbox(req.file.path, req.file.originalname);
      
      // Process with Sonoteller using the public URL
      const sonotellerResult = await processWithSonoteller(songUrl);
      
      // Upload to GridFS
      const gridFsId = await uploadToGridFS(req.file.path, req.file.filename);
      
      // Store in MongoDB
      const songId = await storeSongData(sonotellerResult, gridFsId, req.file.filename, songUrl);
      
      return res.status(200).json({
        success: true,
        message: 'Song processed and stored successfully',
        songId: songId.toString(),
        details: sonotellerResult
      });
    } catch (error) {
      console.error('Processing error:', error);
      return res.status(500).json({ error: 'Error processing song', details: error.message });
    }
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'File upload failed', details: error.message });
  }
});

// Search endpoint
app.get('/search', async (req, res) => {
  try {
    const searchQuery = req.query.q;
    if (!searchQuery) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    // Get embedding for search query
    const embeddingResponse = await embedModel.embedContent(searchQuery);
    const queryEmbedding = embeddingResponse.embedding.values;

    const db = await connectToDatabase();
    const collection = db.collection('songs');

    const songs = await collection.find({}).toArray();
    
    // Calculate similarity scores
    const similarities = songs.map(song => {
      const similarity = cosineSimilarity(queryEmbedding, song.embedding);
      return { 
        songId: song._id, 
        similarity, 
        songData: {
          filename: song.filename,
          summary: song.summary,
          keywords: song.keywords,
          ddex_moods: song.ddex_moods,
          ddex_themes: song.ddex_themes
        }
      };
    });

    similarities.sort((a, b) => b.similarity - a.similarity);
    const topSongs = similarities.slice(0, 5);
    
    return res.status(200).json({
      success: true,
      results: topSongs
    });
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Search failed', details: error.message });
  } finally {
    await closeConnection();
  }
});

// Helper function for similarity calculation
function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload files at: http://localhost:${PORT}/upload`);
});