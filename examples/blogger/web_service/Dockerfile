FROM python:3.12.14-bookworm@sha256:581429e3df12d76e6af4be5ab7d0e7fc2013eb57dc23d2de691411c8efdbb970
WORKDIR /app
COPY requirements.txt requirements.txt
RUN pip install -r requirements.txt
RUN pip install uwsgi
RUN adduser --system --no-create-home uwsgi
USER uwsgi
COPY . .
EXPOSE 3031
HEALTHCHECK --interval=30s --timeout=1s --retries=10 CMD curl http://localhost:3031/healthcheck
CMD ["uwsgi", "app.ini"]
