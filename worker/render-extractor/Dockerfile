FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy package manifest and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Install Chromium browser for Playwright
RUN npx playwright install chromium --with-deps

# Copy service source
COPY opensea-render-extractor.js ./

EXPOSE 3001

CMD ["node", "opensea-render-extractor.js"]
