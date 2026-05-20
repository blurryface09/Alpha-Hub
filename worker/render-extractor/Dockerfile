FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Base image ships with Chromium and all system deps pre-installed.
# Skip --with-deps to avoid apt-get GPG failures on Railway.
RUN npx playwright install chromium

COPY opensea-render-extractor.js ./

EXPOSE 3001

CMD ["node", "opensea-render-extractor.js"]
