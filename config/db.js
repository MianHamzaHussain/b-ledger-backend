import mongoose from 'mongoose';

import logger from '../utils/logger.js';

const connectDB = async () => {
  const conn = await mongoose.connect(process.env.MONGODB_URI, {});

  logger.info(`MongoDB Connected: ${conn.connection.host}`);
};

export default connectDB;
