# Use an official Node runtime as a parent image
FROM node:20-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Install necessary system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    unzip \
    fontconfig \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Ensure UTF-8 locale
RUN locale-gen en_US.UTF-8
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Create directory for authentication info
RUN mkdir -p auth_info_baileys

# Expose any necessary ports (if needed)
# EXPOSE 8080

# Use volume for persistent authentication
VOLUME ["/usr/src/app/auth_info_baileys"]

# Command to run the application
CMD ["node", "index.js"]
