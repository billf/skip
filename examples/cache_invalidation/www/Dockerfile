FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /build
COPY package.json package.json
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
WORKDIR /app
COPY --from=build /build/dist /usr/share/nginx/html

HEALTHCHECK --interval=10s --timeout=1s --retries=10 CMD curl --fail http://localhost/ || exit 1
