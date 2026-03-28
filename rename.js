import fs from "fs";
import path from "path";

const root = process.cwd();

const replacements = [
  // Packages and Links
  { from: /"@choronoforge/g, to: '"@oqronkit' },
  { from: /"chronoforge"/g, to: '"oqronkit"' },
  { from: /"chronoforge":/g, to: '"oqronkit":' },
  { from: /from "chronoforge"/g, to: 'from "oqronkit"' },
  
  // Specific Names and Prefixes
  { from: /ChronoForge/g, to: 'OqronKit' },
  { from: /\[ChronoForge\]/g, to: '[OqronKit]' },
  { from: /ChronoConfig/g, to: 'OqronConfig' },
  { from: /IChronoAdapter/g, to: 'IOqronAdapter' },
  { from: /ChronoAdapter/g, to: 'OqronAdapter' },
  { from: /ChronoRegistry/g, to: 'OqronRegistry' },
  { from: /ChronoEventBus/g, to: 'OqronEventBus' },
  { from: /ChronoWorker/g, to: 'OqronWorker' },
  { from: /ICronContext/g, to: 'ICronContext' }, // Ensure we don't accidentally touch `ICronContext`
  
  // Files / Keys / DB
  { from: /cnforge\.config/g, to: 'oqron.config' },
  { from: /chrono\.sqlite/g, to: 'oqron.sqlite' },
  { from: /chrono_schedules/g, to: 'oqron_schedules' },
  { from: /chrono_jobs/g, to: 'oqron_jobs' },
  { from: /chrono:/g, to: 'oqron:' },
  
  // Any stray 'chronoforge' outside of NPM
  { from: /chronoforge/g, to: 'oqronkit' },
  
  // Also fix stray 'choronoforge' outside of packages
  { from: /choronoforge/g, to: 'oqronkit' }
];

function processDir(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    if (file === "node_modules" || file === ".git" || file === "dist" || file === "rename.js") continue;
    
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      processDir(fullPath);
    } else if (file.match(/\.(ts|js|mjs|json|md)$/)) {
      let content = fs.readFileSync(fullPath, "utf-8");
      let originalContent = content;
      
      for (const rule of replacements) {
        content = content.replace(rule.from, rule.to);
      }
      
      if (content !== originalContent) {
        fs.writeFileSync(fullPath, content, "utf-8");
        console.log("Updated: " + fullPath);
      }
    }
  }
}

console.log("Starting Refactor...");
processDir(root);
console.log("File content replacement complete.");
