import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Environment Variables
dotenv.config();

// Express Application
const app = express();

// Server Port
const PORT = process.env.PORT || 8000;

// Middleware
app.use(
  cors({
    origin: "http://localhost:3000",
  })
);

app.use(express.json());

// Temporary Books API for testing
app.get("/books", (req, res) => {
  res.status(200).json([]);
});

// Start Server
app.listen(PORT, () => {
  console.log(`BookNook Server Running on Port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});