FROM python:3.10.19-bookworm@sha256:44325b079a3c59b1dd0704471fc9ffccd98f13789f00f30bdbdaa99dce03bcc7
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
