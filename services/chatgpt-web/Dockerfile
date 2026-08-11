FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . ./

ENV BACKEND=playwright \
    CHATGPT_WEB_DATA_DIR=/data \
    CHATGPT_WEB_SESSION_FILE=/data/session.json \
    CHATGPT_WEB_CONVERSATION_FILE=/data/conversations.json \
    CHAT_MODEL="GPT-5.6 Sol" \
    CHAT_EFFORT=High \
    STRICT_MODEL_SELECTION=1 \
    PERSIST_CHAT=1 \
    PERSIST_STORE=1 \
    DRY_RUN=0 \
    HOST=0.0.0.0 \
    PORT=8787 \
    HEADED=0

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "umask 077 && exec node server.js"]
