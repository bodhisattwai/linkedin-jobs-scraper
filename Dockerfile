# Use the official Apify actor image with Playwright Chromium support
# This image includes Node.js, Playwright, and Chromium browser
FROM apify/actor-node-playwright-chromium:20

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
# Using --only=prod to exclude devDependencies for smaller image size
RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional \
    && npx playwright install --with-deps chromium

# Copy the source code
COPY . ./

# Set the startup command
CMD npm start
