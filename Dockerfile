FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 3001

# Command to run the application with legacy OpenSSL provider support for media decryption
CMD [ "node", "--openssl-legacy-provider", "src/server.js" ]
