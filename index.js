import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

// =====================================
// ENVIRONMENT CONFIGURATION
// =====================================

dotenv.config();

const app = express();

const PORT = process.env.PORT || 8000;
const uri = process.env.MONGODB_URI;

const AUTH_URL = (
  process.env.BETTER_AUTH_URL || "http://localhost:3000"
).replace(/\/+$/, "");

// =====================================
// EXPRESS MIDDLEWARE
// =====================================

app.use(
  cors({
    origin: "http://localhost:3000",
  })
);

app.use(express.json());

// =====================================
// BETTER AUTH JWT VERIFICATION
// =====================================

const JWKS = createRemoteJWKSet(
  new URL(`${AUTH_URL}/api/auth/jwks`)
);

const verifyJwt = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Unauthorized access. Token missing.",
      });
    }

    const token = authHeader.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        message: "JWT token is required",
      });
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: AUTH_URL,
      audience: AUTH_URL,
    });

    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.email !== "string" ||
      !payload.email
    ) {
      return res.status(401).json({
        message: "Invalid user information",
      });
    }

    req.user = {
      id: payload.sub,
      email: payload.email,
      name:
        typeof payload.name === "string"
          ? payload.name
          : "BookNook User",
    };

    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);

    return res.status(401).json({
      message: "Invalid or expired JWT token",
    });
  }
};

// =====================================
// VALIDATION HELPERS
// =====================================

const allowedCategories = [
  "Fiction",
  "Science",
  "History",
  "Kids",
  "Others",
];

const isValidBookId = (id) => {
  return (
    typeof id === "string" &&
    /^[a-fA-F0-9]{24}$/.test(id)
  );
};

const validateBookData = (data) => {
  const {
    title,
    author,
    category,
    image,
    description,
    totalCopies,
  } = data || {};

  if (
    typeof title !== "string" ||
    !title.trim() ||
    typeof author !== "string" ||
    !author.trim() ||
    typeof image !== "string" ||
    !image.trim() ||
    typeof description !== "string" ||
    !description.trim()
  ) {
    return {
      error: "All book fields are required",
    };
  }

  if (!allowedCategories.includes(category)) {
    return {
      error: "Invalid book category",
    };
  }

  const copies = Number(totalCopies);

  if (!Number.isInteger(copies) || copies < 1) {
    return {
      error: "Total copies must be a positive integer",
    };
  }

  try {
    const imageUrl = new URL(image);

    if (
      !["http:", "https:"].includes(imageUrl.protocol)
    ) {
      throw new Error("Invalid image URL");
    }
  } catch {
    return {
      error: "Please provide a valid image URL",
    };
  }

  return {
    data: {
      title: title.trim(),
      author: author.trim(),
      category,
      image: image.trim(),
      description: description.trim(),
      totalCopies: copies,
    },
  };
};

// =====================================
// MONGODB CONNECTION
// =====================================

async function run() {
  let client;

  try {
    if (!uri) {
      throw new Error("MONGODB_URI is missing in .env");
    }

    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
    });

    await client.connect();

    const database = client.db("booknookDB");

    await database.command({ ping: 1 });

    console.log("MongoDB Connected Successfully!");

    // =====================================
    // COLLECTIONS
    // =====================================

    const booksCollection = database.collection("books");

    // NEW: BORROWS COLLECTION
    const borrowsCollection = database.collection("borrows");

    // Prevent duplicate active borrows
    await borrowsCollection.createIndex(
      {
        userId: 1,
        bookId: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          status: "borrowed",
        },
      }
    );

    console.log("Borrow collection ready!");

    // =====================================
    // API 01: GET ALL BOOKS
    // =====================================

    app.get("/books", async (req, res) => {
      try {
        let cursor = booksCollection
          .find({})
          .sort({
            addedAt: -1,
            _id: -1,
          });

        const limit = Number(req.query.limit);

        if (Number.isInteger(limit) && limit > 0) {
          cursor = cursor.limit(Math.min(limit, 100));
        }

        const books = await cursor.toArray();

        return res.status(200).json(books);
      } catch (error) {
        console.error("Get Books Error:", error.message);

        return res.status(500).json({
          message: "Failed to fetch books",
        });
      }
    });

    // =====================================
    // API 02: GET SINGLE BOOK DETAILS
    // =====================================

    app.get("/books/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidBookId(id)) {
          return res.status(400).json({
            message: "Invalid book ID",
          });
        }

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book) {
          return res.status(404).json({
            message: "Book not found",
          });
        }

        return res.status(200).json(book);
      } catch (error) {
        console.error(
          "Get Single Book Error:",
          error.message
        );

        return res.status(500).json({
          message: "Failed to fetch book details",
        });
      }
    });

    // =====================================
    // API 03: POST ADD NEW BOOK
    // =====================================

    app.post("/books", verifyJwt, async (req, res) => {
      try {
        const validation = validateBookData(req.body);

        if (validation.error) {
          return res.status(400).json({
            message: validation.error,
          });
        }

        const newBook = {
          ...validation.data,

          availableCopies: validation.data.totalCopies,

          addedBy: {
            id: req.user.id,
            name: req.user.name,
            email: req.user.email,
          },

          addedAt: new Date(),
        };

        const result = await booksCollection.insertOne(newBook);

        return res.status(201).json({
          success: true,
          message: "Book added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Add Book Error:", error.message);

        return res.status(500).json({
          success: false,
          message: "Failed to add book",
        });
      }
    });

    // =====================================
    // API 04: PATCH UPDATE BOOK
    // =====================================

    app.patch("/books/:id", verifyJwt, async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidBookId(id)) {
          return res.status(400).json({
            message: "Invalid book ID",
          });
        }

        const bookId = new ObjectId(id);

        const existingBook = await booksCollection.findOne({
          _id: bookId,
        });

        if (!existingBook) {
          return res.status(404).json({
            message: "Book not found",
          });
        }

        // Only owner can edit
        if (existingBook.addedBy?.id !== req.user.id) {
          return res.status(403).json({
            message: "You can only edit your own books",
          });
        }

        const validation = validateBookData(req.body);

        if (validation.error) {
          return res.status(400).json({
            message: validation.error,
          });
        }

        const oldTotal = existingBook.totalCopies;
        const oldAvailable = existingBook.availableCopies;

        if (
          !Number.isInteger(oldTotal) ||
          !Number.isInteger(oldAvailable) ||
          oldAvailable < 0 ||
          oldAvailable > oldTotal
        ) {
          return res.status(409).json({
            message: "Book copy information is inconsistent",
          });
        }

        const borrowedCopies = oldTotal - oldAvailable;
        const newTotal = validation.data.totalCopies;

        if (newTotal < borrowedCopies) {
          return res.status(400).json({
            message:
              `Cannot set total copies below ${borrowedCopies}. ` +
              "Some copies are currently borrowed.",
          });
        }

        const updatedBook = {
          ...validation.data,
          availableCopies: newTotal - borrowedCopies,
          updatedAt: new Date(),
        };

        const result = await booksCollection.updateOne(
          {
            _id: bookId,
            "addedBy.id": req.user.id,
            totalCopies: oldTotal,
            availableCopies: oldAvailable,
          },
          {
            $set: updatedBook,
          }
        );

        if (result.matchedCount === 0) {
          return res.status(409).json({
            message:
              "Book information changed. Please refresh and try again.",
          });
        }

        return res.status(200).json({
          success: true,
          message: "Book updated successfully",
        });
      } catch (error) {
        console.error("Update Book Error:", error.message);

        return res.status(500).json({
          success: false,
          message: "Failed to update book",
        });
      }
    });

    // =====================================
    // API 05: DELETE BOOK
    // =====================================

    app.delete("/books/:id", verifyJwt, async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidBookId(id)) {
          return res.status(400).json({
            message: "Invalid book ID",
          });
        }

        const bookId = new ObjectId(id);

        const existingBook = await booksCollection.findOne({
          _id: bookId,
        });

        if (!existingBook) {
          return res.status(404).json({
            message: "Book not found",
          });
        }

        // Only owner can delete
        if (existingBook.addedBy?.id !== req.user.id) {
          return res.status(403).json({
            message: "You can only delete your own books",
          });
        }

        // Cannot delete currently borrowed books
        if (
          existingBook.availableCopies !==
          existingBook.totalCopies
        ) {
          return res.status(409).json({
            message:
              "This book cannot be deleted while copies are borrowed",
          });
        }

        const result = await booksCollection.deleteOne({
          _id: bookId,
          "addedBy.id": req.user.id,
          totalCopies: existingBook.totalCopies,
          availableCopies: existingBook.availableCopies,
        });

        if (result.deletedCount === 0) {
          return res.status(409).json({
            message:
              "Book information changed. Please refresh and try again.",
          });
        }

        return res.status(200).json({
          success: true,
          message: "Book deleted successfully",
        });
      } catch (error) {
        console.error("Delete Book Error:", error.message);

        return res.status(500).json({
          success: false,
          message: "Failed to delete book",
        });
      }
    });

    // =====================================
    // API 06: POST BORROW BOOK (NEW)
    // =====================================

    app.post("/borrows", verifyJwt, async (req, res) => {
      try {
        const { bookId } = req.body || {};

        // Validate book ID
        if (!isValidBookId(bookId)) {
          return res.status(400).json({
            message: "Invalid book ID",
          });
        }

        const bookObjectId = new ObjectId(bookId);

        // Use a transaction to keep the borrow
        // record and available copies consistent.
        const insertedId = await client.withSession(
          async (session) => {
            return session.withTransaction(async () => {
              // =====================================
              // CHECK DUPLICATE BORROW
              // =====================================

              const existingBorrow =
                await borrowsCollection.findOne(
                  {
                    userId: req.user.id,
                    bookId: bookObjectId,
                    status: "borrowed",
                  },
                  { session }
                );

              if (existingBorrow) {
                const error = new Error(
                  "You have already borrowed this book"
                );

                error.statusCode = 409;
                throw error;
              }

              // =====================================
              // FIND BOOK
              // =====================================

              const book = await booksCollection.findOne(
                {
                  _id: bookObjectId,
                },
                { session }
              );

              if (!book) {
                const error = new Error("Book not found");

                error.statusCode = 404;
                throw error;
              }

              // =====================================
              // CHECK AVAILABLE COPIES
              // =====================================

              if (
                typeof book.availableCopies !== "number" ||
                book.availableCopies < 1
              ) {
                const error = new Error(
                  "This book is currently out of stock"
                );

                error.statusCode = 409;
                throw error;
              }

             

              const updateResult =
                await booksCollection.updateOne(
                  {
                    _id: bookObjectId,
                    availableCopies: { $gt: 0 },
                  },
                  {
                    $inc: {
                      availableCopies: -1,
                    },
                  },
                  { session }
                );

              if (updateResult.modifiedCount !== 1) {
                const error = new Error(
                  "No copies available. Please try again."
                );

                error.statusCode = 409;
                throw error;
              }

             
              const newBorrow = {
                bookId: bookObjectId,

                userId: req.user.id,
                userName: req.user.name,
                userEmail: req.user.email,

                bookTitle: book.title,
                bookAuthor: book.author,
                bookImage: book.image,
                category: book.category,

                status: "borrowed",
                borrowedAt: new Date(),
                returnedAt: null,
              };

              

              const result =
                await borrowsCollection.insertOne(
                  newBorrow,
                  { session }
                );

              return result.insertedId;
            });
          }
        );

       
        

        return res.status(201).json({
          success: true,
          message: "Book borrowed successfully",
          insertedId,
        });
      } catch (error) {
        
        if (error.code === 11000) {
          return res.status(409).json({
            message: "You have already borrowed this book",
          });
        }

        
        if (error.statusCode) {
          return res.status(error.statusCode).json({
            message: error.message,
          });
        }

        console.error("Borrow Book Error:", error.message);

        return res.status(500).json({
          success: false,
          message: "Failed to borrow book",
        });
      }
    });




    

app.get("/borrows/my", verifyJwt, async (req, res) => {
  try {
    const borrows = await borrowsCollection
      .find({
        userId: req.user.id,
      })
      .sort({
        borrowedAt: -1,
      })
      .toArray();

    return res.status(200).json(borrows);

  } catch (error) {
    console.error("Get My Borrows Error:", error.message);

    return res.status(500).json({
      message: "Failed to fetch borrowed books",
    });
  }
});









app.patch(
  "/borrows/:id/return",
  verifyJwt,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidBookId(id)) {
        return res.status(400).json({
          message: "Invalid borrow ID",
        });
      }

      const borrowObjectId = new ObjectId(id);

      await client.withSession(async (session) => {
        await session.withTransaction(async () => {

          // Find Borrow Record
          const borrow = await borrowsCollection.findOne(
            {
              _id: borrowObjectId,
              userId: req.user.id,
            },
            { session }
          );

          if (!borrow) {
            const error = new Error("Borrow record not found");
            error.statusCode = 404;
            throw error;
          }

          // Check Already Returned
          if (borrow.status !== "borrowed") {
            const error = new Error(
              "This book has already been returned"
            );

            error.statusCode = 409;
            throw error;
          }

          // Update Borrow Status
          const borrowResult = await borrowsCollection.updateOne(
            {
              _id: borrowObjectId,
              userId: req.user.id,
              status: "borrowed",
            },
            {
              $set: {
                status: "returned",
                returnedAt: new Date(),
              },
            },
            { session }
          );

          if (borrowResult.modifiedCount !== 1) {
            const error = new Error(
              "Borrow information changed. Please try again."
            );

            error.statusCode = 409;
            throw error;
          }

          // Increase Available Copies
          const bookResult = await booksCollection.updateOne(
            {
              _id: borrow.bookId,
              $expr: {
                $lt: [
                  "$availableCopies",
                  "$totalCopies",
                ],
              },
            },
            {
              $inc: {
                availableCopies: 1,
              },
            },
            { session }
          );

          if (bookResult.modifiedCount !== 1) {
            const error = new Error(
              "Unable to update book availability"
            );

            error.statusCode = 409;
            throw error;
          }

        });
      });

      return res.status(200).json({
        success: true,
        message: "Book returned successfully",
      });

    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      console.error("Return Book Error:", error.message);

      return res.status(500).json({
        message: "Failed to return book",
      });
    }
  }
);

    // =====================================
    // ROUTE REGISTRATION
    // =====================================

    console.log("GET /books registered!");
    console.log("GET /books/:id registered!");
    console.log("POST /books registered!");
    console.log("PATCH /books/:id registered!");
    console.log("DELETE /books/:id registered!");
    console.log("POST /borrows registered!");






    // =====================================
    // START EXPRESS SERVER
    // =====================================

    const server = app.listen(PORT, () => {
      console.log(
        `BookNook Server Running on Port ${PORT}`
      );

      console.log(`http://localhost:${PORT}`);
    });

    server.on("error", (error) => {
      console.error(
        "Express Server Error:",
        error.message
      );

      process.exit(1);
    });
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);

    await client?.close();

    process.exit(1);
  }
}

// =====================================
// RUN APPLICATION
// =====================================

run();