const mongoose = require("mongoose");
const validator = require("validator");

const userSchema = new mongoose.Schema({
    name : {
        type : String,
        required : true,
        trim : true,
    },
    emailId : {
        type: String,
        required : true,
        unique : true,
        lowercase : true,
        trim : true,
        validate(value){
            if(!validator.isEmail(value)){
                throw new Error("Error with Email Id ");
            }
        }

        
    } ,
    password : {
        type : String,
        required : true,
        validate(value){
            if(!validator.isStrongPassword(value)){
                throw new Error("Your password is not strong");
            }
        }
    }
},
{
    timestamps : true
})

const User = mongoose.model("User",userSchema);
module.exports = User;