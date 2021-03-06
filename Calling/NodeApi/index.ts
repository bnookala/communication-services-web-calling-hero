import * as dotenv from 'dotenv';
dotenv.config();

import express, { RequestHandler } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { CommunicationIdentityClient } from '@azure/communication-administration';
import { addFileMetadata, addUserDetails, downloadFile, FileMetadata, FileServiceError, getFileMetadata, getFilesForGroup, getUserDetails, uploadFile } from './fileService';

const uploadMiddleware = multer({ limits: { fieldSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = 5000;

const [
    acsConnectionString,
    storageConnectionString,
] = [
    'ACS_CONNECTION_STRING',
    'STORAGE_CONNECTION_STRING',
].map(envKey => {
    const envValue = process.env[envKey];
    if (envValue === undefined) {
        console.error(`Environment variable not found: ${envKey}`);
        process.exit(1);
    }
    return envValue;
});

const blobContainerName = 'files';
const fileMetadataTableName = 'fileMetadata';
const userDetailTableName = 'userDetails';

// express middleware to validate Authorization header
const fakeAuthMiddleware: RequestHandler = (req, res, next) => {
    const authValue = req.header('Authorization');
    if (!authValue || !authValue.startsWith('user')) {
        res.sendStatus(403);
        return;
    }

    req.userId = authValue;

    next();
};

app.get('/userToken', async (req, res) => {
    const identityClient = new CommunicationIdentityClient(acsConnectionString);

    const userResponse = await identityClient.createUser();
    const tokenResponse = await identityClient.issueToken(userResponse, ["voip"]);

    return res.status(200).json({
        value: {
            token: tokenResponse.token,
            expiresOn: tokenResponse.expiresOn,
            user: {
                id: tokenResponse.user.communicationUserId,
            }
        }
    });
});

app.get('/groups/:groupId/files', fakeAuthMiddleware, async (req, res) => {
    const groupId = req.params['groupId'];
    const userId = req.userId;

    // TODO: Verify that user is allowed to get files for this chat/call
    const users = await getUserDetails(groupId, userId, storageConnectionString, userDetailTableName);
    if (users.length === 0) {
        return res.sendStatus(403);
    }

    const files = await getFilesForGroup(groupId, storageConnectionString, fileMetadataTableName);
    files.sort((a, b) => b.uploadDateTime.getTime() - a.uploadDateTime.getTime());

    return res.status(200).send(files);
});

app.get('/groups/:groupId/files/:fileId', fakeAuthMiddleware, async (req, res) => {
    const groupId = req.params['groupId'];
    const userId = req.userId;

    // TODO: Verify that user is allowed to get files for this chat/call
    const users = await getUserDetails(groupId, userId, storageConnectionString, userDetailTableName);
    if (users.length === 0) {
        return res.sendStatus(403);
    }

    const fileId = req.params['fileId'];

    let file: FileMetadata;
    try {
        file = await getFileMetadata(groupId, fileId, storageConnectionString, fileMetadataTableName);
    } catch (e) {
        if (e instanceof FileServiceError) {
            res.sendStatus(404);
            return;
        }

        throw e;
    }

    const fileStream = await downloadFile(fileId, storageConnectionString, blobContainerName);

    res.attachment(file.name);
    res.contentType('application/octet-stream');
    res.status(200);
    fileStream.pipe(res);
});

interface SendFileRequestBody {
    image?: string;
    fileName?: string;
}

app.post('/groups/:groupId/files', fakeAuthMiddleware, uploadMiddleware.single('file'), async (req, res) => {
    const groupId = req.params['groupId'];
    const userId = req.userId;

    // TODO: Verify that user is allowed to get files for this chat/call
    const users = await getUserDetails(groupId, userId, storageConnectionString, userDetailTableName);
    if (users.length === 0) {
        return res.sendStatus(403);
    }

    const body = req.body as SendFileRequestBody;
    if (req.file === undefined && body?.image === undefined) {
        return res.status(400).send("Invalid file/image");
    }

    if (body?.fileName === undefined) {
        return res.status(400).send("Invalid file name");
    }

    if (groupId === undefined) {
        return res.status(400).send("Invalid group ID");
    }

    // Upload file to Blob Storage
    const newFileId: string = uuidv4();
    if (req.file !== undefined) {
        console.log(`Got file length: ${req.file.size}`);
        await uploadFile(newFileId, req.file.buffer, storageConnectionString, blobContainerName);
    } else {
        console.log(`Got image length: ${body.image?.length}`);
        const buffer = Buffer.from(body.image!, 'base64');
        await uploadFile(newFileId, buffer, storageConnectionString, blobContainerName);
    }

    console.log(`Uploaded blob: ${newFileId}`);

    // Add file metadata to Table Storage
    const newFileMetadata: FileMetadata = {
        id: newFileId,
        name: body.fileName,
        uploadDateTime: new Date(),
    };
    await addFileMetadata(groupId, newFileMetadata, storageConnectionString, fileMetadataTableName);

    console.log('Added file data to table');

    return res.sendStatus(204);
});

app.post( '/groups/:groupId/user',fakeAuthMiddleware, async (req, res) => {
    const groupId = req.params['groupId'];
    const userId = req.userId;
    if (groupId === undefined) {
        return res.status(400).send("Invalid group ID");
    }

    await addUserDetails(groupId, userId,storageConnectionString, userDetailTableName);
    console.log('Added User details to table');
   
    return res.sendStatus(204);
});

app.listen(PORT, () => {
    console.log(`[server]: Server is running at https://localhost:${PORT}`);
});