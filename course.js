const mysql = require("mysql2/promise");
const CONNECTION = mysql.createConnection(process.env.DATABASE_URL);

const CourseCreateRequiredParams = {
  ContentId: "Missing ContentId",
  TimeTrack: "Missing TimeTrack",
  Done: "Missing Done",
};

const fieldsToDelete = [
  "size",
  "url",
  "html_url",
  "git_url",
  "download_url",
  "_links",
  "sha",
];

const fetchSettings = {
  headers: {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
};

const normalizePath = (path) => {
  return path
    .replace(/\d+\s/g, "")
    .replace(/\//g, "-")
    .replace(/\s/g, "-")
    .replace(/-{3,}/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
};

const normalizeName = (name) => {
  return name.replace(/\.[^/.]+$/, "").replace(/\d+\s-\s/g, "");
};

const connectionResolver = async () => {
  if (CONNECTION && CONNECTION.state !== "disconnected") {
    return CONNECTION;
  } else {
    CONNECTION = mysql.createConnection(connectionString);
    CONNECTION.query = util.promisify(CONNECTION.query);

    try {
      await CONNECTION.connect();
      return CONNECTION;
    } catch (err) {
      console.error("Database connection failed: ", err.stack);
      throw err;
    }
  }
};

async function recursiveFetchGithubDir(url) {
  const map = {};
  try {
    const response = await fetch(url, fetchSettings);
    const data = await response.json();
    const directories = data.filter((item) => item.type === "dir");
    const files = data.filter((item) => item.type === "file");

    if (directories && directories.length > 0) {
      for (const directory of directories) {
        const dirData = await recursiveFetchGithubDir(directory.url);
        if (dirData) {
          map[directory.name] = dirData;
        }
      }
    }

    if (files && files.length > 0) {
      for (const file of files) {
        const fileData = await fetchGithubContents(file.url);
        // delete fileData.content;
        if (fileData.content && !file.name.endsWith(".png")) {
          fileData.content = Buffer.from(fileData.content, "base64").toString(
            "utf-8"
          );
        }
        fieldsToDelete.forEach((field) => {
          delete fileData[field];
        });
        fileData.name = normalizeName(fileData.name);
        fileData.path = normalizePath(fileData.path);
        if (fileData) {
          map[file.name] = fileData;
        }
      }
    }

    return map;
  } catch (error) {
    console.error("An error occurred:", error);
    return null;
  }
}

async function fetchGithubContents(url) {
  try {
    const response = await fetch(url, fetchSettings);
    return await response.json();
  } catch (error) {
    console.error("An error occurred:", error);
    return null;
  }
}

// Get all courses on Mysql DB on table courses paginated
module.exports.getAll = async (event) => {
  const userEmail = event.requestContext.authorizer.principalId;
  let { page = 1, size = 10 } = event.queryStringParameters || {
    page: 1,
    size: 10,
  };

  page = parseInt(page);
  size = parseInt(size);

  size = size > 20 ? 20 : size;

  const connection = await connectionResolver();

  // Use the connection
  try {
    const [rows] = await connection.query(
      "SELECT * FROM Course WHERE User_Id = ? LIMIT ?, ?",
      [userEmail, (page - 1) * size, parseInt(size)]
    );
    return {
      statusCode: 200,
      body: JSON.stringify(rows),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify(err),
    };
  }
};

// Get course by id on Mysql DB on table courses
module.exports.get = async (event) => {
  const userEmail = event.requestContext.authorizer.principalId;
  const { courseId } = event.pathParameters || null;

  if (!courseId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing id parameter" }),
    };
  }

  const connection = await connectionResolver();

  // Use the connection
  try {
    console.log(courseId, userEmail);
    const [rows] = await connection.query(
      "SELECT * FROM Course WHERE ContentId = ? AND User_Id = ?",
      [courseId, userEmail]
    );
    return {
      statusCode: 200,
      body: JSON.stringify(rows),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify(err),
    };
  }
};

// Get last accessed courses (UpdatedAt) on Mysql DB on table courses
module.exports.getLastAccessed = async (event) => {
  const userEmail = event.requestContext.authorizer.principalId;
  const { size = 10 } = event.queryStringParameters || { size: 10 };

  const connection = await connectionResolver();

  // Use the connection
  try {
    const [rows] = await connection.query(
      "SELECT * FROM Course WHERE User_Id = ? ORDER BY UpdatedAt DESC LIMIT ?",
      [userEmail, parseInt(size)]
    );
    return {
      statusCode: 200,
      body: JSON.stringify(rows),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify(err),
    };
  }
};

// Create a new course on Mysql DB on table courses
module.exports.create = async (event) => {
  const userEmail = event.requestContext.authorizer.principalId;

  const body = JSON.parse(event.body);

  const missingParam = Object.keys(CourseCreateRequiredParams).find(
    (param) => body[param] === undefined
  );

  if (missingParam) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: CourseCreateRequiredParams[missingParam],
      }),
    };
  }

  const connection = await connectionResolver();

  // Use the connection
  try {
    const [_] = await connection.query(
      `INSERT INTO Course (Id, ContentId, TimeTrack, Done, User_Id, Lessons, CurrentLessonId, EnrollStatus)
        SELECT UUID(), ?, ?, ?, ?, ?, ?, ?
        FROM dual
        WHERE NOT EXISTS (
          SELECT 1
          FROM Course
          WHERE ContentId = ? AND User_Id = ?
        );`,
      [
        body.ContentId,
        body.TimeTrack,
        body.Done,
        userEmail,
        body.ContentUrl,
        userEmail,
        body.Lessons,
        body.CurrentLessonId,
        body.EnrollStatus,
      ]
    );

    if (_.affectedRows === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Course already exists" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Course created successfully" }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify(err),
    };
  }
};

// Update a course on Mysql DB on table courses
module.exports.patch = async (event) => {
  const userEmail = event.requestContext.authorizer.principalId;
  const { courseId } = event.pathParameters || null;
  if (!courseId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing id parameter" }),
    };
  }

  const connection = await connectionResolver();
  // Use the connection
  try {
    const body = JSON.parse(event.body);

    const fieldsNotAllowed = ["Id", "User_Id", "ContentId"]; // Fields not allowed for update

    const fieldsToUpdate = {};
    Object.keys(body).forEach((key) => {
      if (!fieldsNotAllowed.includes(key)) {
        fieldsToUpdate[key] = body[key];
      }
    });

    if (fieldsToUpdate.lessons?.length > 0) {
      fieldsToUpdate.lessons = JSON.stringify(fieldsToUpdate.lessons);
    }

    const updateQuery = `UPDATE Course SET ${Object.keys(fieldsToUpdate)
      .map((key) => `${key} = ?`)
      .join(", ")} WHERE Id = ? AND User_Id = ?`;

    const updateValues = Object.values(fieldsToUpdate);
    updateValues.push(courseId);
    updateValues.push(userEmail);

    connection.query(updateQuery, updateValues);

    // Check if course body has only has lessons and no other property on it if so, return getSignedUrlPromise
    if (
      Object.keys(fieldsToUpdate).length === 1 &&
      Object.keys(fieldsToUpdate)[0] === "lessons"
    ) {
      const signedUrl = await getSignedUrlPromise();
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Course updated successfully",
          signedUrl,
        }),
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Course updated successfully" }),
    };
  } catch (error) {
    console.error("Error updating course:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to update course" }),
    };
  }
};

const getSignedUrlPromise = async () => {
  const { v4: uuidv4 } = require("uuid");
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const bucketName = process.env.BUCKET_NAME;
  const fileName = uuidv4();

  // Configure AWS SDK
  AWS.config.update({ region, accessKeyId, secretAccessKey });

  const s3 = new AWS.S3();

  const expirationTime = 900; // 15 minutes

  const params = {
    Bucket: bucketName,
    Key: fileName,
    Expires: expirationTime,
    ContentType: "image/jpeg",
    ACL: "private",
  };

  try {
    const presignedUrl = await s3.getSignedUrlPromise("putObject", params);
    return presignedUrl;
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Error generating presigned URL" }),
    };
  }
};
