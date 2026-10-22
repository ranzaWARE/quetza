FROM python:3.11-slim

WORKDIR /app

# Dipendenze sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Dipendenze Python. torch nella versione solo CPU: quella di PyPI include
# CUDA (diversi GB in più) che qui non si usa, il container gira su CPU.
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.2.2 torchaudio==2.2.2 \
 && pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Directory per i modelli (montata come volume)
RUN mkdir -p /app/models

EXPOSE 9876

CMD ["python", "server.py"]