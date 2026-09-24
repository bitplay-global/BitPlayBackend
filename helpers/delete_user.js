import mongoose from "mongoose";

const MONGO_URI = process.env.MONGODB_URI;

const deleteUserByEmail = async (email) => {
  try {
    if (!email) throw new Error("Email is required to delete a user.");

    await mongoose.connect(MONGO_URI);

    const usersCollection = mongoose.connection.db.collection("users");

    const result = await usersCollection.deleteOne({ email: email.toLowerCase() });

    if (result.deletedCount === 0) {
      console.log("No user found with that email.");
    } else {
      console.log("User deleted successfully!");
    }
  } catch (err) {
    console.error("Error deleting user:", err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

// deleteUserByEmail("hieutran421999@gmail.com");
deleteUserByEmail("kashifcarstrading@gmail.com");
