# T-A4-SOLVER-WORKER — image mínima do worker A4 (separada do Dockerfile do app Node).
# Build: docker build -t a4-solver solver/   · Run: docker run -e A4_SOLVER_SECRET=… -p 8080:8080 a4-solver
FROM python:3.11-slim
RUN pip install --no-cache-dir ortools==9.15.6755
WORKDIR /app
COPY cbc_solve.py worker.py ./
ENV PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
USER nobody
CMD ["python", "worker.py"]
