const fs = require('fs');
const path = require('path');

const srcViews = path.resolve(__dirname, '..', 'src', 'views');
const distViews = path.resolve(__dirname, '..', 'dist', 'views');

if (fs.existsSync(srcViews)) {
  fs.mkdirSync(distViews, { recursive: true });
  for (const file of fs.readdirSync(srcViews)) {
    fs.copyFileSync(path.join(srcViews, file), path.join(distViews, file));
  }
  console.log('✅ Views HTML copiadas para dist/views com sucesso.');
}
