const fs = require('fs');
const path = require('path');

const outputFile = 'PROJECT_CONTEXT_2FIX.txt';
// רשימת הקבצים והתיקיות שאנחנו רוצים
const includeExtensions = ['.js', '.html', '.css', '.json', '.sql'];
const excludeDirs = ['node_modules', '.git', '.env'];
const excludeFiles = ['package-lock.json', outputFile, 'pack_project.js'];

let outputContent = "--- ZOE PROJECT CURRENT STATE ---\n\n";

function scanDirectory(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (!excludeDirs.includes(file)) scanDirectory(fullPath);
        } else {
            const ext = path.extname(file);
            if (includeExtensions.includes(ext) && !excludeFiles.includes(file)) {
                console.log(`Adding: ${fullPath}`);
                const content = fs.readFileSync(fullPath, 'utf8');
                outputContent += `\n\n==================================================\n`;
                outputContent += `FILE PATH: ${fullPath}\n`;
                outputContent += `==================================================\n`;
                outputContent += content;
            }
        }
    }
}

scanDirectory('./'); // מתחיל מהתיקייה הנוכחית
fs.writeFileSync(outputFile, outputContent);
console.log(`\n✅ Done! File created: ${outputFile}`);