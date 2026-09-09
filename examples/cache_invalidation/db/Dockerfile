FROM postgres:17.11@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675
ENV POSTGRES_PASSWORD="change_me"
COPY schema.sql /docker-entrypoint-initdb.d/schema.sql
HEALTHCHECK --interval=1s --timeout=5s --retries=10 CMD pg_isready -h 127.0.0.1
USER postgres
