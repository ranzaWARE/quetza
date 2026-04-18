FROM python:3.11-slim

WORKDIR /app

# Dipendenze sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Dipendenze Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Directory per i modelli (montata come volume)
RUN mkdir -p /app/models

EXPOSE 9876

CMD ["python", "server.py"]