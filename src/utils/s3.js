const AWS = require('aws-sdk');
const fs = require('fs');
const { promisify } = require('util');
const unlinkFile = promisify(fs.unlink);

// Configure AWS
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const s3 = new AWS.S3();

// Upload file to S3
const uploadToS3 = async (file, folder = '') => {
    const fileStream = fs.createReadStream(file.path);
    
    const uploadParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Body: fileStream,
        Key: `${folder}/${Date.now()}-${file.originalname}`,
        ContentType: file.mimetype
    };

    try {
        const result = await s3.upload(uploadParams).promise();
        // Delete the local file after successful upload
        await unlinkFile(file.path);
        return result.Location;
    } catch (error) {
        console.error('S3 upload error:', error);
        throw error;
    }
};

// Download file from S3
const downloadFromS3 = async (key) => {
    const downloadParams = {
        Key: key,
        Bucket: process.env.AWS_BUCKET_NAME
    };

    try {
        return s3.getObject(downloadParams).createReadStream();
    } catch (error) {
        console.error('S3 download error:', error);
        throw error;
    }
};

// Delete file from S3
const deleteFromS3 = async (key) => {
    const deleteParams = {
        Key: key,
        Bucket: process.env.AWS_BUCKET_NAME
    };

    try {
        await s3.deleteObject(deleteParams).promise();
    } catch (error) {
        console.error('S3 delete error:', error);
        throw error;
    }
};

// Get signed URL for temporary access
const getSignedUrl = async (key, expirySeconds = 3600) => {
    const params = {
        Key: key,
        Bucket: process.env.AWS_BUCKET_NAME,
        Expires: expirySeconds
    };

    try {
        return await s3.getSignedUrlPromise('getObject', params);
    } catch (error) {
        console.error('S3 signed URL error:', error);
        throw error;
    }
};

module.exports = {
    uploadToS3,
    downloadFromS3,
    deleteFromS3,
    getSignedUrl
}; 