FROM node:22

# Install system dependencies and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    jq \
    wget \
    gnupg \
    software-properties-common \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Java (OpenJDK 17)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

# Install Maven
ENV MAVEN_VERSION=3.9.6
RUN wget https://archive.apache.org/dist/maven/maven-3/$MAVEN_VERSION/binaries/apache-maven-$MAVEN_VERSION-bin.tar.gz \
    && tar -xzf apache-maven-$MAVEN_VERSION-bin.tar.gz -C /opt \
    && ln -s /opt/apache-maven-$MAVEN_VERSION /opt/maven \
    && rm apache-maven-$MAVEN_VERSION-bin.tar.gz

# Install Gradle
ENV GRADLE_VERSION=8.5
RUN wget https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip \
    && unzip gradle-$GRADLE_VERSION-bin.zip -d /opt \
    && ln -s /opt/gradle-$GRADLE_VERSION /opt/gradle \
    && rm gradle-$GRADLE_VERSION-bin.zip

# Install Python 3 and pip (for pytest)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install .NET SDK (for NUnit)
RUN wget https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O packages-microsoft-prod.deb \
    && dpkg -i packages-microsoft-prod.deb \
    && rm packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-sdk-8.0 \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for build tools
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH=$PATH:$JAVA_HOME/bin:$MAVEN_HOME/bin:$GRADLE_HOME/bin:/usr/local/bin

WORKDIR /build

# Copy package files and source code for building
COPY package.json tsconfig.json /build/
COPY src/ /build/src/

# Install dependencies and build TypeScript
RUN npm install && npm run build

# Now set up the application directory
WORKDIR /app

# worker/package.json references file:../myridius-cli-agent-0.9.2.tgz,
# so the tarball must exist at filesystem root relative to /app.
COPY myridius-cli-agent-0.9.2.tgz /myridius-cli-agent-0.9.2.tgz
COPY worker/package.json /app/package.json
RUN npm install --omit=dev

# Copy compiled JavaScript from build directory (worker imports from ../src/lib)
RUN cp -r /build/dist/src/ /src/

# Create symlink so /src code can find node_modules from /app
RUN ln -s /app/node_modules /src/node_modules

# worker/test-execution.js imports ../dist/src/lib/... (relative to /app), so also expose the build at /dist/src
RUN mkdir -p /dist && cp -r /build/dist/src /dist/src && ln -s /app/node_modules /dist/node_modules

# The CLI tarball ships a .env with credentials; it is not needed at runtime.
RUN rm -f /app/node_modules/myridius/.env

# Copy worker application files
COPY worker/ /app/
# Strip CRLF in case the repo was checked out on Windows (core.autocrlf)
RUN sed -i 's/\r$//' /app/scripts/startup.sh && chmod +x /app/scripts/startup.sh
# projects/ (CLI transcripts) and worker-sessions/ (manifests) are volume mount points; creating them here
# makes new named volumes inherit node ownership. Only config/ (CLI state) is written at runtime; chown-ing all of
# /app (node_modules) copies every file into a new layer and takes minutes.
RUN mkdir -p /app/config/projects /app/config/worker-sessions && chown -R node:node /app/config

# Verify build tools are accessible and create verification script
RUN echo '#!/bin/bash\necho "=== Build Tools Verification ==="\necho "Java: $(which java || echo NOT_FOUND)"\njava -version 2>&1 | head -1 || echo "Java not working"\necho "Maven: $(which mvn || echo NOT_FOUND)"\nmvn -version 2>&1 | head -1 || echo "Maven not working"\necho "Gradle: $(which gradle || echo NOT_FOUND)"\necho "Node: $(which node)"\necho "================================"' > /usr/local/bin/verify-tools && chmod +x /usr/local/bin/verify-tools

USER node

ENV NODE_ENV=production
ENV MYRIDIUS_CLI_AGENT="backend-specialist"
ENV MYRIDIUS_CLI_FULL_AUTO="1"
ENV MYRIDIUS_CLI_PERMISSION_MODE=""
ENV MYRIDIUS_CLI_ALLOW_ROOT_BYPASS="1"
ENV MYRIDIUS_CLI_DANGEROUSLY_SKIP_PERMISSIONS="0"
ENV MYRIDIUS_CLI_STREAM_LINE_LOGS="1"
ENV MYRIDIUS_CLI_OUTPUT_FORMAT="stream-json"
ENV MYRIDIUS_CLI_VERBOSE="1"
ENV MYRIDIUS_CLI_COMMAND=""
ENV EVENT_HUB_CONSUMER_GROUP="claude-code-worker"

CMD ["/app/scripts/startup.sh"]




