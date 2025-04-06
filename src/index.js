import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const encodedParams = new URLSearchParams();
encodedParams.set('file', String.raw`C:\Users\samar\Downloads\warm_guitar.wav`);

const url = 'https://sonoteller-ai1.p.rapidapi.com/lyrics_ddex';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': `${process.env.RAPID_API_KEY}`,
    'x-rapidapi-host': 'sonoteller-ai1.p.rapidapi.com',
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: encodedParams
};

async function fetchLyrics() {
    try {
        const response = await fetch(url, options);
        const result = await response.json();
        console.log(result);
    } catch (error) {
        console.error(error);
    }
}

fetchLyrics();