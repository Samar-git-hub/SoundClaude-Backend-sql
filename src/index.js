const load_dotenv = require('dotenv').config();

load_dotenv;

const encodedParams = new URLSearchParams();
encodedParams.set('file', 'https://storage.googleapis.com/musikame-files/thefatrat-mayday-feat-laura-brehm-lyriclyrics-videocopyright-free-music.mp3');

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
        const result = await response.text();
        console.log(result);
    } catch (error) {
        console.error(error);
    }
}

fetchLyrics();