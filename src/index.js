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
import { connectToDatabase } from './db.js';
import { GridFSBucket, ObjectId } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${path.basename(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

app.use('/uploads', express.static(uploadDir));

// Upload to Catbox.moe
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
    return response.data;
  } catch (error) {
    console.error('Catbox upload error:', error);
    throw error;
  }
}

// Process with Sonoteller
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

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Invalid JSON response: ${responseText}`);
  }
}

// Upload to GridFS with MIME type
async function uploadToGridFS(filePath, filename, mimeType) {
  const db = await connectToDatabase();
  const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });

  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: mimeType
    });
    const readStream = fs.createReadStream(filePath);

    readStream.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

// Store song data
async function storeSongData(songData, fileId, filename, songUrl) {
  const db = await connectToDatabase();
  const combinedText = [
    songData.summary || '',
    ...Object.values(songData.keywords || {}),
    ...Object.values(songData['ddex moods'] || {}),
    ...Object.values(songData['ddex themes'] || {})
  ].join(' ');

  const embeddingResponse = await embedModel.embedContent(combinedText);
  const embedding = embeddingResponse.embedding.values;

  const song = {
    songUrl,
    audioFileId: fileId,
    filename,
    language: songData.language || 'unknown',
    language_iso: songData["language-iso"] || 'unknown',
    summary: songData.summary || '',
    explicit: songData.explicit || false,
    keywords: Object.values(songData.keywords || {}),
    ddex_moods: Object.values(songData["ddex moods"] || {}),
    ddex_themes: Object.values(songData["ddex themes"] || {}),
    flags: songData.flags || {},
    embedding,
    created_at: new Date(),
  };

  const collection = db.collection('songs');
  const result = await collection.insertOne(song);
  return result.insertedId;
}

// Upload endpoint
app.post('/upload', upload.single('songFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`File uploaded locally: ${req.file.originalname}`);

    const songUrl = await uploadToCatbox(req.file.path, req.file.originalname);
    const sonotellerResult = await processWithSonoteller(songUrl);
    const gridFsId = await uploadToGridFS(req.file.path, req.file.filename, req.file.mimetype);
    const songId = await storeSongData(sonotellerResult, gridFsId, req.file.filename, songUrl);

    // Clean up local file
    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      success: true,
      message: 'Song processed and stored successfully',
      songId: songId.toString(),
      details: sonotellerResult
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'File upload failed', details: error.message });
  }
});

// Search endpoint with audioFileId
app.get('/search', async (req, res) => {
  try {
    const searchQuery = req.query.q;
    if (!searchQuery) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const embeddingResponse = await embedModel.embedContent(searchQuery);
    const queryEmbedding = embeddingResponse.embedding.values;

    const db = await connectToDatabase();
    const collection = db.collection('songs');
    const songs = await collection.find({}).toArray();

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
          ddex_themes: song.ddex_themes,
          audioFileId: song.audioFileId.toString() // Include audio file ID
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
  }
});

// New audio streaming endpoint
app.get('/audio/:id', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });

    const fileId = new ObjectId(req.params.id);
    const downloadStream = bucket.openDownloadStream(fileId);

    if (req.query.download === 'true') {
      const file = await bucket.find({ _id: fileId }).toArray();
      const filename = file[0]?.filename || 'audio.mp3';
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
    }

    downloadStream.pipe(res);
  } catch (error) {
    console.error('Error streaming audio:', error);
    if (error.message.includes('FileNotFound')) {
      res.status(404).json({ error: 'Audio file not found' });
    } else {
      res.status(500).json({ error: 'Failed to stream audio' });
    }
  }
});

// Cosine similarity function
function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload files at: http://localhost:${PORT}/upload`);
});