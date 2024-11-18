const fs = require('fs');

const envPath = '.env';
const examplePath = '.env.example';

if (!fs.existsSync(envPath)) {
  console.error(`Error: ${envPath} does not exist.`);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const exampleContent = envContent
  .split('\n')
  .map(line => {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      return line; // Keep comments and empty lines
    }
    const [key] = line.split('=');
    return `${key}=`;
  })
  .join('\n');

fs.writeFileSync(examplePath, exampleContent);
console.log(`${examplePath} updated successfully.`);
