FROM node:23-alpine3.20

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npx prisma generate

RUN npm run build

EXPOSE 5000

CMD ["npm","run", "start"]