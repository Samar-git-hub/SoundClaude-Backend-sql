const qs = require('querystring'); //hi
const http = require('https');

const options = {
	method: 'POST',
	hostname: 'sonoteller-ai1.p.rapidapi.com',
	port: null,
	path: '/lyrics_ddex',
	headers: {
		'x-rapidapi-host': 'sonoteller-ai1.p.rapidapi.com',
		'Content-Type': 'application/x-www-form-urlencoded'
	}
};

const req = http.request(options, function (res) {
	const chunks = [];

	res.on('data', function (chunk) {
		chunks.push(chunk);
	});

	res.on('end', function () {
		const body = Buffer.concat(chunks);
		console.log(body.toString());
	});
});

req.write(qs.stringify({
  file: 'https://storage.googleapis.com/musikame-files/thefatrat-mayday-feat-laura-brehm-lyriclyrics-videocopyright-free-music.mp3'
}));



req.end();