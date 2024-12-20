const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const multer = require('multer');
const fs = require('fs-extra');
const crypto = require('crypto');
const app = express();
const port = 3000;

const tempUploadDir = 'uploads/'; // Temp chunk storage
const finalUploadDir = 'final-uploads/'; // Final assembled file storage
const metadataDir = 'metadata/'; // Metadata storage (file format)
const transcodedDir = 'transcoded/'

const videoDir = path.join(__dirname, '../transcoded');

// Ensure directories exist
fs.ensureDirSync(tempUploadDir);
fs.ensureDirSync(finalUploadDir);
fs.ensureDirSync(metadataDir);
fs.ensureDirSync(transcodedDir);

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../public')));

// Route to list all videos
app.get('/videos', (req, res) => {
    fs.readdir(videoDir, (err, files) => {
        if (err) {
            console.error('Error reading video directory:', err.message);
            return res.status(500).send('Unable to scan video directory');
        }

        // Object to store videos by base name
        const videos = {};

        // Loop through files and organize them
        files.forEach(file => {
            // Match files that are of the format: name_resolution.mp4 (e.g., movie1_720P.mp4)
            const parts = file.split('_');
            if (parts.length !== 2 || !parts[1].endsWith('.mp4')) {
                console.log('Invalid file format:', file);
                return; // Skip invalid file names
            }

            const baseName = parts[0]; // First part before `_`
            const resolution = parts[1].replace('.mp4', ''); // Remove `.mp4` from the second part

            if (!/^\d{3,4}[Pp]$/.test(resolution)) {
                console.log('Invalid resolution format:', resolution);
                return; // Skip files with invalid resolution formats
            }
            // If the base name doesn't exist in the object, initialize it
            if (!videos[baseName]) {
                videos[baseName] = [];
            }

            // Store file info in the video object
            videos[baseName].push({ resolution,file });
        });
        // Send the transformed JSON response
    res.json(videos);
});
});
    



// Route to serve individual video files
app.get('/video/:filename', (req, res) => {
    const filePath = path.join(videoDir, req.params.filename);

    fs.stat(filePath, (err, stats) => {
        if (err) {
            return res.status(404).send('Video not found');
        }

        const range = req.headers.range;
        const fileSize = stats.size;

        if (range) {
            const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
            const start = parseInt(startStr, 10);
            const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

            const chunkSize = (end - start) + 1;
            const fileStream = fs.createReadStream(filePath, { start, end });

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'video/mp4',
            });

            fileStream.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            });

            fs.createReadStream(filePath).pipe(res);
        }
    });
});

// Chunk upload route
app.post('/upload-chunk', upload.single('chunk'), async (req, res) => {
    const { chunkIndex, totalChunks, uniqueId, originalName } = req.body;

    // Validate the incoming request
    if (!chunkIndex || !totalChunks || !uniqueId || !originalName) {
        return res.status(400).send('Missing required metadata in request body');
    }

    const chunk = req.file;

    if (!chunk) {
        return res.status(400).send('No chunk uploaded');
    }

    const tempDir = path.join(tempUploadDir, uniqueId);

    try {
        await fs.ensureDir(tempDir);
        const chunkPath = path.join(tempDir, `chunk_${chunkIndex}`);
        await fs.outputFile(chunkPath, chunk.buffer);

        // Save metadata (file format) when the first chunk is uploaded
        if (parseInt(chunkIndex) === 0) {
            const ext = path.extname(originalName);
            const metadataPath = path.join(metadataDir, `${uniqueId}.json`);
            const metadata = {
                originalName,
                format: ext
            };
            await fs.writeJson(metadataPath, metadata);
        }

        // If last chunk is uploaded, reassemble the file
        if (parseInt(chunkIndex) === parseInt(totalChunks) - 1) {
            const finalFileName = generateUniqueFileName(originalName);
            await reassembleChunks(tempDir, finalFileName, totalChunks, uniqueId);
            return res.status(200).send('File upload complete.');
        }

        res.status(200).send('Chunk uploaded successfully.');
    } catch (err) {
        console.error('Error uploading chunk:', err);
        res.status(500).send('Error uploading chunk.');
    }
});

// Reassemble all chunks into a single file
async function reassembleChunks(tempDir, finalFileName, totalChunks, uniqueId) {
    try {
        const finalPath = path.join(finalUploadDir, finalFileName);
        const writeStream = fs.createWriteStream(finalPath);

        for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(tempDir, `chunk_${i}`);
            if (await fs.pathExists(chunkPath)) {
                const data = await fs.readFile(chunkPath);
                writeStream.write(data);
            } else {
                throw new Error(`Missing chunk: ${chunkPath}`);
            }
        }

        writeStream.end();
        await fs.remove(tempDir); // Remove temp directory after reassembling
        startMultipleTranscodings(finalPath, finalFileName, uniqueId)
    } catch (e) {
        console.log(e.message)
    }
}

// Generate a unique file name
function generateUniqueFileName(originalName) {
    const ext = path.extname(originalName);
    // const baseName = path.basename(originalName, ext);
    const uniqueSuffix = crypto.randomBytes(8).toString('hex');
    return `${uniqueSuffix}${ext}`;
}

// Start transcoding to 480p, 720p, and 1080p at 30fps
function startMultipleTranscodings(inputFile, fileName, videoId) {
    const transcodedDir = './transcoded'; // Directory to store transcoded videos

    const resolutions = [
        { label: '480p', size: '854x480' },
        { label: '720p', size: '1280x720' },
        { label: '1080p', size: '1920x1080' }
    ];

    resolutions.forEach(({ label, size }) => {
        const outputFileName = `${path.basename(inputFile, path.extname(inputFile))}_${label}.mp4`;
        const outputPath = path.join(transcodedDir, outputFileName);

        const command = `ffmpeg -i ${inputFile} -s ${size} -r 30 -c:v libx264 -preset fast -crf 23 ${outputPath}`;

        exec(command, async (err) => {
            if (err) {
                console.error(`Error during transcoding to ${label}: ${err.message}`);
                return;
            }

            console.log(`Transcoding to ${label} complete: ${outputPath}`);

            // Save the transcoded path (this assumes you have a function to save to the database)
            // await saveTranscodedFilePathToDB(videoId, outputPath, label, 'mp4');
        });
    });
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

//change in code