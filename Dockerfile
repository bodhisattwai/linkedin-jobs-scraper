# Use the official Apify actor image with Playwright support
# This image includes Node.js, Playwright, and other necessary dependencies
FROM apify/actor-node-playwright:20

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
# Using --only=prod to exclude devDependencies for smaller image size
RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional

# Copy the source code
COPY . ./

# Set the startup command
CMD npm start
